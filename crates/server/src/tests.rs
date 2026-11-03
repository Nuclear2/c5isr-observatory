use super::*;

fn fixture() -> Inner {
    Inner {
        engine: Engine::new(20261022),
        server_epoch: "offline-test".into(),
        model: ModelStatus {
            provider: "codex".into(),
            available: true,
            busy: false,
            last_error: None,
            last_run_tick: None,
            detail: "Offline injected output; no CLI".into(),
        },
        journal: vec![],
        model_runs: vec![],
        automation: AutomationStatus::default(),
        active_job: None,
        job_sequence: 0,
    }
}

fn enable_ai(inner: &mut Inner, now: Instant) {
    inner.automation.mode = "ai".into();
    inner.automation.phase = "waiting".into();
    inner.automation.next_due = Some(now);
    inner.automation.generation += 1;
    inner.engine.set_running(true);
}

fn output(inner: &Inner) -> Value {
    json!({"proposals":[{
        "title":"离线测试保持", "rationale":"检验信息任务调度", "action":"hold", "subject_id":"command",
        "evidence_ids":[inner.engine.snapshot().observations[0].id],
        "uncertainties":["合成变量"], "expected_effect":"保持当前状态"
    }], "summary":"Offline fixture", "usage":null})
}

#[test]
fn manual_clock_never_launches_model_or_approves_tasks() {
    let mut inner = fixture();
    inner.engine.set_running(true);
    for _ in 0..20 {
        assert!(advance_scheduler(&mut inner, std::path::Path::new("."), Instant::now()).is_none());
    }
    assert!(!inner.model.busy);
    assert_eq!(inner.engine.snapshot().metrics.completed_tasks, 0);
    assert_eq!(inner.model_runs.len(), 0);
}

#[test]
fn ai_validates_auto_approves_new_model_tasks_and_executes_them_only() {
    let mut inner = fixture();
    let now = Instant::now();
    enable_ai(&mut inner, now);
    let baseline: Vec<String> = inner
        .engine
        .snapshot()
        .proposals
        .iter()
        .map(|p| p.id.clone())
        .collect();
    let job = advance_scheduler(&mut inner, std::path::Path::new("."), now).unwrap();
    let response = output(&inner);
    finish_job(&mut inner, &job, Ok(response));
    let state = inner.engine.snapshot();
    assert!(
        state
            .proposals
            .iter()
            .filter(|p| baseline.contains(&p.id))
            .all(|p| p.status == "pending")
    );
    assert_eq!(
        state
            .proposals
            .iter()
            .find(|p| p.source == "codex")
            .unwrap()
            .status,
        "approved"
    );
    assert_eq!(inner.automation.auto_approved, 1);
    assert_eq!(inner.automation.cycles_completed, 1);
    assert!(
        inner
            .journal
            .iter()
            .any(|entry| entry["kind"] == "auto_review")
    );
    for second in 1..6 {
        assert!(
            advance_scheduler(
                &mut inner,
                std::path::Path::new("."),
                now + Duration::from_secs(second)
            )
            .is_none()
        );
    }
    assert_eq!(
        inner
            .engine
            .snapshot()
            .proposals
            .iter()
            .find(|p| p.source == "codex")
            .unwrap()
            .status,
        "completed"
    );
    assert_eq!(inner.engine.snapshot().metrics.completed_tasks, 1);
}

#[test]
fn inference_freezes_evidence_and_cadence_is_wall_clock_even_at_eight_times_speed() {
    let mut inner = fixture();
    inner.engine.set_speed(8).unwrap();
    let now = Instant::now();
    enable_ai(&mut inner, now);
    let job = advance_scheduler(&mut inner, std::path::Path::new("."), now).unwrap();
    assert!(
        advance_scheduler(
            &mut inner,
            std::path::Path::new("."),
            now + Duration::from_secs(10)
        )
        .is_none()
    );
    assert_eq!(inner.engine.snapshot().tick, job.input_tick);
    assert_eq!(inner.job_sequence, 1);
    let response = output(&inner);
    finish_job(&mut inner, &job, Ok(response));
    assert!(
        advance_scheduler(
            &mut inner,
            std::path::Path::new("."),
            now + Duration::from_secs(11)
        )
        .is_none()
    );
    assert!(
        advance_scheduler(
            &mut inner,
            std::path::Path::new("."),
            now + Duration::from_secs(59)
        )
        .is_none()
    );
    assert!(
        advance_scheduler(
            &mut inner,
            std::path::Path::new("."),
            now + Duration::from_secs(60)
        )
        .is_some()
    );
    assert_eq!(inner.job_sequence, 2);
}

#[test]
fn stop_discards_late_response_and_never_restarts() {
    let mut inner = fixture();
    let now = Instant::now();
    enable_ai(&mut inner, now);
    let job = advance_scheduler(&mut inner, std::path::Path::new("."), now).unwrap();
    let response = output(&inner);
    stop_automation(&mut inner, None);
    assert!(inner.model.busy); // A stopping process still occupies the one-call slot.
    finish_job(&mut inner, &job, Ok(response));
    assert!(!inner.model.busy);
    assert_eq!(inner.automation.mode, "manual");
    assert!(!inner.engine.snapshot().running);
    assert!(
        !inner
            .engine
            .snapshot()
            .proposals
            .iter()
            .any(|p| p.source == "codex")
    );
    assert!(
        advance_scheduler(
            &mut inner,
            std::path::Path::new("."),
            now + Duration::from_secs(600)
        )
        .is_none()
    );
    assert_eq!(inner.engine.snapshot().tick, 0);
}

#[test]
fn reset_rejects_old_output_without_polluting_new_run() {
    let mut inner = fixture();
    let job = prepare_job(&mut inner, std::path::Path::new("."), false, Instant::now()).unwrap();
    let response = output(&inner);
    inner.engine = Engine::new(999);
    inner.journal.clear();
    finish_job(&mut inner, &job, Ok(response));
    assert!(inner.journal.is_empty());
    assert!(inner.model_runs.is_empty());
    assert!(!inner.model.busy);
    assert!(
        !inner
            .engine
            .snapshot()
            .proposals
            .iter()
            .any(|p| p.source == "codex")
    );
}

#[test]
fn provider_failure_stops_ai_and_does_not_fall_back_to_baseline() {
    let mut inner = fixture();
    let now = Instant::now();
    enable_ai(&mut inner, now);
    let job = advance_scheduler(&mut inner, std::path::Path::new("."), now).unwrap();
    finish_job(&mut inner, &job, Err("offline injected failure".into()));
    assert_eq!(inner.automation.mode, "manual");
    assert_eq!(inner.automation.phase, "error");
    assert_eq!(
        inner.automation.last_error.as_deref(),
        Some("offline injected failure")
    );
    assert!(!inner.engine.snapshot().running);
    assert!(
        inner
            .engine
            .snapshot()
            .proposals
            .iter()
            .all(|p| p.status == "pending")
    );
    assert!(
        advance_scheduler(
            &mut inner,
            std::path::Path::new("."),
            now + Duration::from_secs(600)
        )
        .is_none()
    );
}

#[test]
fn invalid_model_action_cannot_bypass_validation_in_ai_mode() {
    let mut inner = fixture();
    let now = Instant::now();
    enable_ai(&mut inner, now);
    let job = advance_scheduler(&mut inner, std::path::Path::new("."), now).unwrap();
    let mut response = output(&inner);
    response["proposals"][0]["action"] = json!("invalid-action");
    finish_job(&mut inner, &job, Ok(response));
    assert_eq!(inner.automation.phase, "error");
    assert_eq!(inner.automation.auto_approved, 0);
    assert!(
        !inner
            .engine
            .snapshot()
            .proposals
            .iter()
            .any(|p| p.source == "codex")
    );
    assert_eq!(inner.model_runs[0]["accepted"], false);
}

#[test]
fn manual_inference_still_requires_human_review() {
    let mut inner = fixture();
    let job = prepare_job(&mut inner, std::path::Path::new("."), false, Instant::now()).unwrap();
    let response = output(&inner);
    finish_job(&mut inner, &job, Ok(response));
    assert_eq!(
        inner
            .engine
            .snapshot()
            .proposals
            .iter()
            .find(|p| p.source == "codex")
            .unwrap()
            .status,
        "pending"
    );
    assert_eq!(inner.automation.auto_approved, 0);
}

#[test]
fn slow_inference_does_not_start_overlapping_calls_or_skip_execution() {
    let mut inner = fixture();
    let now = Instant::now();
    inner.engine.set_speed(8).unwrap();
    enable_ai(&mut inner, now);
    let job = advance_scheduler(&mut inner, std::path::Path::new("."), now).unwrap();
    let after_slow_response = now + Duration::from_secs(100);
    assert!(
        advance_scheduler(&mut inner, std::path::Path::new("."), after_slow_response).is_none()
    );
    let response = output(&inner);
    finish_job(&mut inner, &job, Ok(response));
    // Even with cadence elapsed, accepted work executes before the next inference.
    assert!(
        advance_scheduler(&mut inner, std::path::Path::new("."), after_slow_response).is_none()
    );
    assert_eq!(inner.engine.snapshot().metrics.completed_tasks, 1);
    assert!(
        advance_scheduler(
            &mut inner,
            std::path::Path::new("."),
            after_slow_response + Duration::from_secs(1)
        )
        .is_some()
    );
    assert_eq!(inner.job_sequence, 2);
}

#[tokio::test]
async fn cancellation_marker_failure_still_invalidates_response_and_stops_mode() {
    let mut inner = fixture();
    let now = Instant::now();
    enable_ai(&mut inner, now);
    let missing_root = std::env::temp_dir().join(format!(
        "c5isr-missing-{}-{}",
        std::process::id(),
        inner.engine.snapshot().run_id
    ));
    let job = advance_scheduler(&mut inner, &missing_root, now).unwrap();
    let response = output(&inner);
    stop_automation(&mut inner, None);
    assert!(cancel_active(&mut inner).await.is_err());
    assert!(inner.model.busy);
    assert!(!inner.engine.snapshot().running);
    finish_job(&mut inner, &job, Ok(response));
    assert!(!inner.model.busy);
    assert_eq!(inner.automation.auto_approved, 0);
    assert!(inner.model_runs.is_empty());
}
