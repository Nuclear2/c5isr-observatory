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
        strategy_studies: vec![],
        receipt_studies: vec![],
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
    let decision_view = inner.view();
    let approved: Vec<&Value> = decision_view["decision_log"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "approved")
        .collect();
    assert_eq!(approved.len(), 1);
    assert_eq!(approved[0]["actor"], "ai");
    assert_eq!(
        approved[0]["proposal_id"],
        state
            .proposals
            .iter()
            .find(|p| p.source == "codex")
            .unwrap()
            .id
    );
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
    let conflict = prepare_job(&mut inner, std::path::Path::new("."), false, now)
        .err()
        .expect("a stopping job must reject overlapping manual inference");
    assert_eq!(conflict.0, StatusCode::CONFLICT);
    assert_eq!(inner.job_sequence, 1);
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
    assert!(
        inner.view()["decision_log"]
            .as_array()
            .unwrap()
            .iter()
            .all(|entry| entry["kind"] != "approved")
    );
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
    let before_review = inner.view();
    assert!(
        before_review["decision_log"]
            .as_array()
            .unwrap()
            .iter()
            .all(|entry| entry["kind"] != "approved")
    );
    let id = inner
        .engine
        .snapshot()
        .proposals
        .into_iter()
        .find(|proposal| proposal.source == "codex")
        .unwrap()
        .id;
    inner.engine.review(&id, true).unwrap();
    let after_review = inner.view();
    let approved = after_review["decision_log"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["kind"] == "approved" && entry["proposal_id"] == id)
        .unwrap();
    assert_eq!(approved["actor"], "human");
}

#[test]
fn model_input_allowlist_excludes_decision_archive_contacts_and_display_text() {
    let mut inner = fixture();
    inner.engine.inject("link_loss").unwrap();
    for _ in 0..40 {
        inner.engine.step();
    }
    let snapshot = inner.engine.snapshot();
    let own_ids: HashSet<&str> = snapshot
        .units
        .iter()
        .filter(|unit| unit.side == "blue")
        .map(|unit| unit.id.as_str())
        .collect();
    assert!(snapshot.units.iter().any(|unit| unit.side == "red"));
    assert!(snapshot.history.len() > 1);
    assert!(!snapshot.events.is_empty());
    assert!(!inner.view()["decision_log"].as_array().unwrap().is_empty());

    let job = prepare_job(&mut inner, std::path::Path::new("."), false, Instant::now()).unwrap();
    let input = &job.input;
    let keys =
        |value: &Value| -> HashSet<String> { value.as_object().unwrap().keys().cloned().collect() };
    let expected_keys = |names: &[&str]| -> HashSet<String> {
        names.iter().map(|name| (*name).to_string()).collect()
    };
    assert_eq!(
        keys(input),
        expected_keys(&[
            "schema_version",
            "tick",
            "units",
            "links",
            "observations",
            "proposals",
            "metrics"
        ])
    );
    for unit in input["units"].as_array().unwrap() {
        assert_eq!(
            keys(unit),
            expected_keys(&["id", "side", "domain", "connection"])
        );
        assert_eq!(unit["side"], "blue");
        assert!(own_ids.contains(unit["id"].as_str().unwrap()));
    }
    for observation in input["observations"].as_array().unwrap() {
        assert_eq!(
            keys(observation),
            expected_keys(&[
                "id",
                "unit_id",
                "source_id",
                "observed_tick",
                "received_tick",
                "confidence",
            ])
        );
        assert!(own_ids.contains(observation["unit_id"].as_str().unwrap()));
        assert!(own_ids.contains(observation["source_id"].as_str().unwrap()));
    }
    for link in input["links"].as_array().unwrap() {
        assert_eq!(
            keys(link),
            expected_keys(&["id", "from", "to", "quality", "latency_ticks", "enabled"])
        );
        assert!(own_ids.contains(link["from"].as_str().unwrap()));
        assert!(own_ids.contains(link["to"].as_str().unwrap()));
    }
    for proposal in input["proposals"].as_array().unwrap() {
        assert_eq!(
            keys(proposal),
            expected_keys(&["action", "subject_id", "status"])
        );
    }
    assert_eq!(
        keys(&input["metrics"]),
        expected_keys(&[
            "delivered",
            "dropped",
            "pending_messages",
            "avg_latency_ticks",
            "freshness",
            "completed_tasks",
        ])
    );
    let serialized = input.to_string();
    for unit in snapshot.units.iter().filter(|unit| unit.side == "red") {
        assert!(!serialized.contains(&unit.id));
        assert!(!serialized.contains(&unit.name));
    }
    // The existing command-sourced local status evidence remains usable by the
    // bridge; free-form explanatory notes and report lifecycle data do not.
    let mut local_snapshot = snapshot;
    local_snapshot.observations[0].source_id = "command".into();
    local_snapshot.observations[0].note = "DO_NOT_SEND_LOCAL_EVIDENCE_NOTE".into();
    local_snapshot.report_versions[0].report_id = "DO_NOT_SEND_REPORT_LEDGER".into();
    let local_input = bridge_input(&local_snapshot);
    assert_eq!(local_input["observations"][0]["source_id"], "command");
    assert!(local_input.get("report_versions").is_none());
    let serialized = local_input.to_string();
    assert!(!serialized.contains("DO_NOT_SEND_REPORT_LEDGER"));
    assert!(!serialized.contains("DO_NOT_SEND_LOCAL_EVIDENCE_NOTE"));
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
