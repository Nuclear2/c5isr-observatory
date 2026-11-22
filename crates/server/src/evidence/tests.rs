use super::*;

#[test]
fn selected_frame_projects_only_read_reports_and_visible_ancestry() {
    let archive = run_lab(&LabConfig::default()).unwrap();
    let mut saw_backlog = false;
    for frame in archive
        .immediate
        .frames
        .iter()
        .chain(&archive.review.frames)
    {
        let read: Vec<_> = frame
            .reports
            .iter()
            .filter(|r| r.read_tick.is_some())
            .collect();
        if read.is_empty() {
            assert!(matches!(
                advice_input(frame),
                Err(ApiError(StatusCode::BAD_REQUEST, _))
            ));
            continue;
        }
        saw_backlog |= !frame.queue_ids.is_empty();
        let input = advice_input(frame).unwrap();
        assert_eq!(input.payload.as_object().unwrap().len(), 2);
        assert_eq!(input.payload["tick"], frame.tick);
        assert_eq!(
            input.read_ids,
            read.iter().map(|r| r.id.as_str()).collect::<Vec<_>>()
        );
        let reports = input.payload["reports"].as_array().unwrap();
        assert_eq!(reports.len(), read.len());
        for (report, original) in reports.iter().zip(read) {
            assert_eq!(report.as_object().unwrap().len(), 10);
            assert_eq!(report["id"], original.id);
            assert!(report["source_id"].as_str().unwrap().starts_with("source-"));
            assert_eq!(report["kind"], original.kind);
            assert_eq!(report["claim"], original.claim);
            assert_eq!(report["period_start"], original.period_start);
            assert_eq!(report["period_end"], original.period_end);
            assert_eq!(report["received_tick"], original.received_tick);
            assert_eq!(report["read_tick"], original.read_tick.unwrap());
            assert_eq!(report["derived_from"], json!(original.derived_from));
            assert_eq!(report["revises"], json!(original.revises));
        }
    }
    assert!(saw_backlog);
    // Even a quotation received before its parent may not disclose that parent.
    let mut masked = archive.immediate.frames.last().unwrap().clone();
    masked
        .reports
        .iter_mut()
        .find(|r| r.id == "R1")
        .unwrap()
        .read_tick = None;
    let masked = advice_input(&masked).unwrap();
    assert!(!masked.read_ids.iter().any(|id| id == "R1"));
    let reports = masked.payload["reports"].as_array().unwrap();
    let find = |id: &str| reports.iter().find(|r| r["id"] == id).unwrap();
    assert_eq!(find("R2")["derived_from"], Value::Null);
    assert_eq!(find("R4")["revises"], Value::Null);
}

#[test]
fn server_validates_cited_sources_without_replacing_the_model_estimate() {
    let archive = run_lab(&LabConfig::default()).unwrap();
    let frame = archive.immediate.frames.last().unwrap();
    let input = advice_input(frame).unwrap();
    let opinion = json!({
        "action":"request_review","evidence_ids":["R1","R2"],"source_count":2,
        "reason":"需要核对转述来源。","uncertainties":["原始记录是否准确"],
        "usage":{"input_tokens":200}
    });
    let validate = |value| validated_advice(value, &input, Branch::Immediate, frame.tick);
    let result = validate(opinion.clone()).unwrap();
    assert!(input.read_ids.iter().any(|id| id == "R3"));
    assert_eq!(result["evidence_ids"], json!(["R1", "R2"]));
    assert_eq!(result["source_count"], 2);
    assert_eq!(result["verified_source_count"], 1);
    assert_eq!(result["tick"], frame.tick);
    assert_eq!(result["branch"], "immediate");
    for (key, value) in [
        ("action", json!("approve")),
        ("evidence_ids", json!(["R1", "R1"])),
        ("evidence_ids", json!(["R5"])),
        ("evidence_ids", json!([])),
        ("source_count", json!(3)),
        ("reason", json!(" ")),
        ("uncertainties", json!([""])),
        ("execute", json!(true)),
    ] {
        let mut invalid = opinion.clone();
        invalid[key] = value;
        assert!(validate(invalid).is_err(), "{key}");
    }
}

/// This temporary root contains only a fixture script. The production Codex
/// bridge and the user's executable and credentials are never consulted.
struct OfflineBridge(PathBuf);

impl OfflineBridge {
    fn new() -> Self {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("c5isr-evidence-{}-{stamp}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join("scripts")).unwrap();
        std::fs::create_dir_all(root.join("runtime/cancel")).unwrap();
        std::fs::write(root.join("scripts/codex-bridge.mjs"), r#"
            import { existsSync } from 'node:fs';
            if (process.argv[2] !== 'evidence-advice' || process.argv[3] !== '--cancel-file') process.exit(1);
            let text = '';
            for await (const chunk of process.stdin) text += chunk;
            const packet = JSON.parse(text);
            const reply = () => console.log(JSON.stringify({
                action: 'hold', evidence_ids: [packet.reports[0].id], source_count: 1,
                reason: '离线样例', uncertainties: [], usage: null
            }));
            if (packet.reports.some(r => r.id === 'R4')) {
                const cutoff = setTimeout(() => process.exit(2), 5000);
                const interval = setInterval(() => {
                    if (existsSync(process.argv[4])) {
                        clearInterval(interval); clearTimeout(cutoff); reply();
                    }
                }, 10);
            } else reply();
        "#).unwrap();
        Self(root)
    }
}

impl Drop for OfflineBridge {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(self.0.join("scripts/codex-bridge.mjs"));
        for path in ["scripts", "runtime/cancel", "runtime"] {
            let _ = std::fs::remove_dir(self.0.join(path));
        }
        let _ = std::fs::remove_dir(&self.0);
    }
}

#[tokio::test]
async fn live_stop_and_reset_preserve_a_separate_evidence_consultation() {
    let fake = OfflineBridge::new();
    let app = crate::process_tests::app_fixture(fake.0.clone());
    let request = "lab-consultation";
    let (job_id, marker) = {
        let mut inner = app.inner.lock().await;
        inner.model.available = true;
        inner.engine.step();
        inner.engine.set_running(true);
        reserve_model(&mut inner, &app.root, Some(request.into())).unwrap()
    };
    let verify_owner = |inner: &Inner| {
        let job = inner
            .active_job
            .as_ref()
            .expect("lab job is still reserved");
        assert_eq!(job.id, job_id);
        assert_eq!(job.advice_request.as_deref(), Some(request));
        assert!(!job.cancelled);
        assert!(inner.model.busy);
        assert!(!marker.exists());
    };
    let stopped = automation(
        State(app.clone()),
        Json(AutomationCommand {
            mode: "manual".into(),
        }),
    )
    .await
    .unwrap();
    assert_eq!(stopped.0["running"], false);
    verify_owner(&*app.inner.lock().await);

    let reset = control(
        State(app.clone()),
        Json(Control {
            action: "reset".into(),
            value: Some(99),
        }),
    )
    .await
    .unwrap();
    assert_eq!(reset.0["tick"], 0);
    verify_owner(&*app.inner.lock().await);

    let response = cancel(
        State(app.clone()),
        Json(CancelRequest {
            request_id: request.into(),
        }),
    )
    .await
    .unwrap();
    assert_eq!(response.0["cancelled"], true);
    assert!(
        app.inner
            .lock()
            .await
            .active_job
            .as_ref()
            .unwrap()
            .cancelled
    );
    assert_eq!(std::fs::read(&marker).unwrap(), b"cancel");
    std::fs::remove_file(marker).unwrap();
}

#[tokio::test]
async fn isolated_advice_releases_its_slot_and_discards_late_output_after_owner_cancels() {
    let fake = OfflineBridge::new();
    let app = crate::process_tests::app_fixture(fake.0.clone());
    app.inner.lock().await.model.available = true;
    let archive = run_lab(&LabConfig::default()).unwrap();
    let request = |id: &str, tick| {
        Json(AdviceRequest {
            config: LabConfig::default(),
            branch: Branch::Immediate,
            tick,
            request_id: id.into(),
        })
    };
    let cancel_request = |id: &str| {
        Json(CancelRequest {
            request_id: id.into(),
        })
    };
    let original = app.inner.lock().await.view();
    let response = advice(State(app.clone()), request("review-A", archive.fork_tick))
        .await
        .unwrap();
    assert_eq!(response.0["provider"], "codex");
    assert_eq!(response.0["evidence_ids"], json!(["R1"]));
    assert_eq!(response.0["verified_source_count"], 1);

    let mut updates = app.updates.subscribe();
    let pending = tokio::spawn(advice(
        State(app.clone()),
        request("review-B", archive.end_tick),
    ));
    tokio::time::timeout(
        Duration::from_secs(3),
        updates.wait_for(|value| {
            serde_json::from_str::<Value>(value).unwrap()["model"]["busy"] == true
        }),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        cancel(State(app.clone()), cancel_request("review-A"))
            .await
            .unwrap_err()
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        advice(State(app.clone()), request("review-C", archive.fork_tick))
            .await
            .unwrap_err()
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        cancel(State(app.clone()), cancel_request("review-B"))
            .await
            .unwrap()
            .0["cancelled"],
        true
    );
    let result = tokio::time::timeout(Duration::from_secs(7), pending)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.unwrap_err().0, StatusCode::CONFLICT);
    assert_eq!(
        cancel(State(app.clone()), cancel_request("review-B"))
            .await
            .unwrap_err()
            .0,
        StatusCode::CONFLICT
    );

    let mut inner = app.inner.lock().await;
    assert!(inner.active_job.is_none());
    assert_eq!(inner.view(), original);
    assert!(inner.journal.is_empty());
    assert!(inner.model_runs.is_empty());
    inner.automation.mode = "ai".into();
    drop(inner);
    assert_eq!(
        advice(State(app.clone()), request("review-D", archive.fork_tick))
            .await
            .unwrap_err()
            .0,
        StatusCode::CONFLICT
    );
}
