use super::*;

fn proposal(engine: &Engine, action: &str, subject: &str) -> ModelProposal {
    ModelProposal {
        title: "合成信息任务测试".into(),
        rationale: "检验已知信息的处理与审阅记录。".into(),
        action: action.into(),
        subject_id: subject.into(),
        evidence_ids: vec![if subject == COMMAND {
            engine.state.observations.last().unwrap().id.clone()
        } else {
            engine.latest_evidence(subject).unwrap()
        }],
        uncertainties: vec!["全部参数均为合成变量。".into()],
        expected_effect: "记录信息处理事实，不推断现实能力。".into(),
    }
}

fn add(engine: &mut Engine, action: &str, subject: &str) -> String {
    engine
        .add_model_proposals(vec![proposal(engine, action, subject)])
        .unwrap();
    engine.state.proposals.last().unwrap().id.clone()
}

fn outage_request(engine: &Engine) -> String {
    engine
        .state
        .proposals
        .iter()
        .find(|proposal| {
            proposal.action == "request_observation"
                && proposal.subject_id == "pla-kj700"
                && proposal.status == "pending"
        })
        .unwrap()
        .id
        .clone()
}

fn facts<'a>(engine: &'a Engine, id: &str) -> Vec<&'a DecisionEvent> {
    engine
        .state
        .decision_log
        .iter()
        .filter(|event| event.proposal_id == id)
        .collect()
}

fn report_for<'a>(engine: &'a Engine, proposal_id: &str) -> &'a ReportVersion {
    engine
        .current()
        .report_versions
        .iter()
        .find(|row| row.proposal_id.as_deref() == Some(proposal_id))
        .unwrap()
}

#[test]
fn both_desks_start_with_the_same_own_reports_and_only_approved_samples_create_editions() {
    let mut engine = Engine::new(801);
    let initial = engine.current().report_versions.clone();
    assert_eq!(initial.len(), engine.current().units.len() - 1);
    for row in &initial {
        let observation = engine
            .current()
            .observations
            .iter()
            .find(|o| o.id == row.report_id)
            .unwrap();
        assert_eq!(observation.source_id, row.source_id);
        assert_eq!(observation.unit_id, row.source_id);
        assert!(
            engine
                .current()
                .units
                .iter()
                .any(|u| u.id == row.source_id && u.id != COMMAND && u.side == "blue")
        );
        assert_eq!(
            (row.version, row.sampled_tick, row.proposal_id.as_deref()),
            (1, 0, None)
        );
        assert_eq!(
            (row.field_received_tick, row.center_received_tick),
            (Some(0), Some(0))
        );
    }
    engine.inject("link_loss").unwrap();
    engine.review(&outage_request(&engine), false).unwrap();
    engine.inject("recover").unwrap();
    for _ in 0..80 {
        engine.step();
    }
    assert!(engine.current().perception.total_discovered > 0);
    assert_eq!(engine.current().report_versions, initial);
    assert_eq!(Engine::new(801).current().report_versions, initial);
}

#[test]
fn both_receipts_refer_to_the_same_version_and_are_only_stamped_on_arrival() {
    let mut engine = Engine::new(20261022);
    engine.inject("link_loss").unwrap();
    engine.step();
    let id = outage_request(&engine);
    engine.review(&id, true).unwrap();
    engine.step();
    assert!(
        !engine
            .current()
            .report_versions
            .iter()
            .any(|r| r.proposal_id.as_deref() == Some(&id))
    );
    engine.step();
    let issued = report_for(&engine, &id).clone();
    assert_eq!((issued.version, issued.sampled_tick), (2, 3));
    assert_eq!(
        (issued.field_received_tick, issued.center_received_tick),
        (None, None)
    );
    assert_eq!(
        facts(&engine, &id)
            .iter()
            .find(|e| e.kind == "buffered")
            .unwrap()
            .report_id
            .as_deref(),
        Some(issued.report_id.as_str())
    );
    for _ in 0..3 {
        engine.step();
    }
    assert_eq!(report_for(&engine, &id).field_received_tick, Some(4));
    assert_eq!(report_for(&engine, &id).center_received_tick, None);
    engine.inject("recover").unwrap();
    for _ in 6..9 {
        assert_eq!(report_for(&engine, &id).center_received_tick, None);
        engine.step();
    }
    let row = report_for(&engine, &id);
    let received = facts(&engine, &id)
        .into_iter()
        .find(|e| e.kind == "received")
        .unwrap();
    assert_eq!(row.report_id, issued.report_id);
    assert_eq!(row.center_received_tick, Some(received.tick));
    assert_eq!(
        (row.field_received_tick, row.center_received_tick),
        (Some(4), Some(9))
    );
}

fn assert_current_frame(engine: &Engine) {
    let frame = engine.state.history.last().unwrap();
    assert_eq!(frame.tick, engine.state.tick);
    assert_eq!(frame.decision_seq, engine.decision_seq);
    assert_eq!(frame.metrics, engine.state.metrics);
    assert_eq!(frame.links, engine.state.links);
    assert!(
        engine
            .state
            .history
            .windows(2)
            .all(|pair| pair[0].tick < pair[1].tick)
    );
}

#[test]
fn same_tick_decisions_replace_frame_and_freeze_each_evidence_version() {
    let mut engine = Engine::new(701);
    let id = engine
        .state
        .proposals
        .iter()
        .find(|p| p.action == "review_data")
        .unwrap()
        .id
        .clone();
    let created = facts(&engine, &id)[0].clone();
    let original = created.evidence.as_ref().unwrap()[0].clone();
    assert_eq!(created.proposal.as_ref().unwrap().status, "pending");
    engine.review(&id, true).unwrap();
    let approved = facts(&engine, &id)[1].clone();
    assert_eq!(approved.actor.as_deref(), Some("human"));
    assert_eq!(approved.evidence.as_ref().unwrap()[0], original);
    let rejected_id = engine
        .state
        .proposals
        .iter()
        .find(|p| p.action == "restore_link")
        .unwrap()
        .id
        .clone();
    engine.review(&rejected_id, false).unwrap();
    assert_eq!(
        facts(&engine, &rejected_id).last().unwrap().kind,
        "rejected"
    );
    let ai_id = add(&mut engine, "hold", COMMAND);
    engine.review_automatic(&ai_id).unwrap();
    assert_eq!(
        facts(&engine, &ai_id).last().unwrap().actor.as_deref(),
        Some("ai")
    );
    engine.inject("link_loss").unwrap();
    assert_eq!(engine.state.history.len(), 1);
    assert_current_frame(&engine);
    assert_eq!(engine.state.metrics.completed_tasks, 0);
    engine.step();
    engine.step();
    assert!(
        engine
            .state
            .observations
            .iter()
            .find(|o| o.id == original.id)
            .unwrap()
            .confidence
            > original.confidence
    );
    assert_eq!(facts(&engine, &id)[0], &created);
    assert_eq!(facts(&engine, &id)[1], &approved);
    assert_eq!(facts(&engine, &id).last().unwrap().kind, "completed");
    assert_eq!(facts(&engine, &id).last().unwrap().tick, 2);
    assert_current_frame(&engine);
}

#[test]
fn automatic_review_cannot_approve_baseline_or_duplicate_human_decisions() {
    let mut engine = Engine::new(702);
    let baseline = engine.state.proposals[0].id.clone();
    let before = engine.snapshot();
    assert!(engine.review_automatic(&baseline).is_err());
    assert_eq!(engine.snapshot(), before);
    let id = add(&mut engine, "hold", COMMAND);
    engine.review(&id, false).unwrap();
    let before = engine.snapshot();
    assert!(engine.review_automatic(&id).is_err());
    assert!(engine.review(&id, true).is_err());
    assert_eq!(engine.snapshot(), before);
    let mut invalid = proposal(&engine, "request_observation", "pla-j20");
    invalid.subject_id = "contact-000001".into();
    assert!(engine.add_model_proposals(vec![invalid]).is_err());
    assert_eq!(engine.snapshot(), before);
}

#[test]
fn long_outage_has_fresh_local_evidence_without_faking_received_node_data() {
    let mut engine = Engine::new(703);
    let delivered = engine.state.metrics.delivered;
    engine.inject("link_loss").unwrap();
    let id = outage_request(&engine);
    let created = facts(&engine, &id)[0];
    let evidence = &created.evidence.as_ref().unwrap()[0];
    assert_eq!(evidence.source_id, COMMAND);
    assert_eq!(evidence.unit_id, "pla-kj700");
    assert_eq!(engine.state.metrics.delivered, delivered);
    engine.inject("link_loss").unwrap();
    assert_eq!(outage_request(&engine), id);
    for _ in 0..150 {
        engine.step();
    }
    let new_id = outage_request(&engine);
    assert_ne!(new_id, id);
    assert!(
        facts(&engine, &id)
            .iter()
            .any(|event| event.kind == "stale")
    );
    let requests = engine
        .state
        .decision_log
        .iter()
        .filter(|event| {
            event.kind == "created"
                && event.proposal.as_ref().is_some_and(|p| {
                    p.subject_id == "pla-kj700" && p.action == "request_observation"
                })
        })
        .count();
    assert!(
        requests <= 5,
        "outage should not create a proposal every tick: {requests}"
    );
    assert!(
        !engine
            .state
            .observations
            .iter()
            .any(|o| o.source_id == "pla-kj700")
    );
    engine.review(&new_id, true).unwrap();
    assert_current_frame(&engine);
}

#[test]
fn buffered_request_recovery_preserves_sample_time_and_actual_receipt() {
    // Also fixes the public HTTP acceptance scenario's seed and command ordering.
    let mut engine = Engine::new(20261022);
    engine.inject("link_loss").unwrap();
    engine.step();
    let id = outage_request(&engine);
    engine.review(&id, true).unwrap();
    for _ in 0..5 {
        engine.step();
    }
    let pending = engine
        .queue
        .iter()
        .find(|message| message.proposal_id.as_deref() == Some(&id))
        .unwrap()
        .clone();
    assert!(pending.buffered);
    assert_eq!(pending.observation.observed_tick, 3);
    assert!(
        !engine
            .state
            .observations
            .iter()
            .any(|o| o.id == pending.observation.id)
    );
    assert_eq!(
        engine
            .state
            .proposals
            .iter()
            .find(|p| p.id == id)
            .unwrap()
            .status,
        "completed"
    );
    assert_eq!(engine.state.metrics.completed_tasks, 1);
    assert!(
        facts(&engine, &id)
            .iter()
            .any(|event| event.kind == "buffered" && event.tick == 3)
    );
    engine.inject("recover").unwrap();
    let sent = facts(&engine, &id)
        .into_iter()
        .find(|event| event.kind == "sent")
        .expect("fixed seed should send after recovery")
        .clone();
    assert_eq!(sent.tick, 6);
    assert_eq!(sent.sampled_tick, Some(3));
    assert!(sent.evidence.is_none());
    assert_current_frame(&engine);
    let due = engine
        .queue
        .iter()
        .find(|message| message.proposal_id.as_deref() == Some(&id))
        .unwrap()
        .due;
    assert!((8..=10).contains(&due));
    while engine.state.tick < due {
        engine.step();
    }
    let received = facts(&engine, &id)
        .into_iter()
        .find(|event| event.kind == "received")
        .unwrap();
    assert_eq!(received.tick, due);
    assert_eq!(received.sampled_tick, Some(3));
    let observation = &received.evidence.as_ref().unwrap()[0];
    assert_eq!(observation.observed_tick, 3);
    assert_eq!(observation.received_tick, due);
    assert_eq!(received.report_id.as_deref(), Some(observation.id.as_str()));
    assert!(engine.state.observations.contains(observation));
    assert_current_frame(&engine);
}

#[test]
fn reinterruption_never_delivers_and_same_tick_recovery_is_bounded() {
    let mut engine = Engine::new(704);
    engine
        .state
        .links
        .iter_mut()
        .find(|l| l.from == "pla-kj700")
        .unwrap()
        .quality = 1.0;
    let id = add(&mut engine, "request_observation", "pla-kj700");
    engine.review(&id, true).unwrap();
    engine.step();
    engine.step();
    let report_id = engine
        .queue
        .iter()
        .find(|m| m.proposal_id.as_deref() == Some(&id))
        .unwrap()
        .observation
        .id
        .clone();
    engine.inject("link_loss").unwrap();
    assert!(facts(&engine, &id).last().unwrap().kind == "buffered");
    for _ in 0..20 {
        engine.inject("recover").unwrap();
        engine.inject("link_loss").unwrap();
    }
    assert_eq!(
        facts(&engine, &id)
            .iter()
            .filter(|event| event.kind == "sent")
            .count(),
        1
    );
    for _ in 0..10 {
        engine.step();
    }
    assert!(!engine.state.observations.iter().any(|o| o.id == report_id));
    assert!(
        !facts(&engine, &id)
            .iter()
            .any(|event| event.kind == "received")
    );
    assert!(
        engine
            .queue
            .iter()
            .find(|m| m.observation.id == report_id)
            .unwrap()
            .buffered
    );
    // Restore the transport for a deterministic successful resend in this test.
    let link = engine
        .state
        .links
        .iter_mut()
        .find(|l| l.from == "pla-kj700")
        .unwrap();
    link.enabled = true;
    link.quality = 1.0;
    engine.step();
    let due = engine
        .queue
        .iter()
        .find(|m| m.observation.id == report_id)
        .unwrap()
        .due;
    while engine.state.tick < due {
        engine.step();
    }
    let received = facts(&engine, &id)
        .into_iter()
        .find(|e| e.kind == "received")
        .unwrap();
    assert_eq!(received.sampled_tick, Some(2));
    assert_eq!(received.tick, due);
}

#[test]
fn expired_or_lost_supplement_is_never_reported_as_received() {
    let mut expired = Engine::new(705);
    expired.inject("link_loss").unwrap();
    let id = outage_request(&expired);
    expired.review(&id, true).unwrap();
    for _ in 0..62 {
        expired.step();
    }
    assert_eq!(
        facts(&expired, &id)
            .iter()
            .filter(|event| event.kind == "expired")
            .count(),
        1
    );
    assert_eq!(facts(&expired, &id).last().unwrap().tick, 62);
    assert_eq!(facts(&expired, &id).last().unwrap().sampled_tick, Some(2));
    expired.inject("recover").unwrap();
    for _ in 0..12 {
        expired.step();
    }
    assert_eq!(report_for(&expired, &id).field_received_tick, Some(3));
    assert_eq!(report_for(&expired, &id).center_received_tick, None);
    assert!(
        !facts(&expired, &id)
            .iter()
            .any(|event| event.kind == "received")
    );
    assert!(
        !expired
            .queue
            .iter()
            .any(|message| message.proposal_id.as_deref() == Some(&id))
    );

    let mut lost = Engine::new(706);
    let link = lost
        .state
        .links
        .iter_mut()
        .find(|l| l.from == "pla-j20")
        .unwrap();
    link.quality = 0.0;
    let id = add(&mut lost, "request_observation", "pla-j20");
    lost.review(&id, true).unwrap();
    for _ in 0..8 {
        lost.step();
    }
    assert!(
        facts(&lost, &id)
            .iter()
            .any(|event| event.kind == "dropped" && event.tick == 2)
    );
    assert!(
        !facts(&lost, &id)
            .iter()
            .any(|event| event.kind == "received")
    );
    assert_eq!(lost.state.metrics.completed_tasks, 1);
    assert_eq!(report_for(&lost, &id).field_received_tick, Some(3));
    assert_eq!(report_for(&lost, &id).center_received_tick, None);
}

#[test]
fn window_preserves_each_desks_highest_edition_even_after_an_older_receipt_arrives_late() {
    let mut engine = Engine::new(802);
    let source = "pla-j20";
    let link_index = engine
        .state
        .links
        .iter()
        .position(|link| link.from == source)
        .unwrap();
    engine.state.links[link_index].quality = 1.0;
    engine.state.links[link_index].latency_ticks = 12;
    let delayed = add(&mut engine, "request_observation", source);
    engine.review(&delayed, true).unwrap();
    engine.step();
    engine.step();
    engine.state.links[link_index].latency_ticks = 1;
    let faster = add(&mut engine, "request_observation", source);
    engine.review(&faster, true).unwrap();
    while engine.current().tick < 10 {
        engine.step();
    }
    assert_eq!(report_for(&engine, &delayed).center_received_tick, None);
    let first_receipt = report_for(&engine, &faster).center_received_tick.unwrap();
    while engine.current().tick < 17 {
        engine.step();
    }
    assert!(report_for(&engine, &delayed).center_received_tick.unwrap() > first_receipt);
    assert_eq!(
        report_for(&engine, &faster).center_received_tick,
        Some(first_receipt)
    );
    engine.state.links[link_index].quality = 0.0;
    let lost = add(&mut engine, "request_observation", source);
    engine.review(&lost, true).unwrap();
    while engine.state.tick < 20 {
        engine.step();
    }
    for _ in 0..MAX_PROPOSALS {
        let id = add(&mut engine, "hold", COMMAND);
        engine.review(&id, false).unwrap();
    }
    assert!(
        !engine
            .state
            .proposals
            .iter()
            .any(|p| p.id == faster || p.id == lost)
    );
    while engine.state.tick < MAX_HISTORY as u64 + 20 {
        engine.step();
    }
    let rows: Vec<_> = engine
        .current()
        .report_versions
        .iter()
        .filter(|row| row.source_id == source)
        .collect();
    assert_eq!(rows.len(), 2);
    assert_eq!(
        (rows[0].version, rows[0].center_received_tick),
        (3, Some(first_receipt))
    );
    assert_eq!(
        (
            rows[1].version,
            rows[1].field_received_tick,
            rows[1].center_received_tick
        ),
        (4, Some(20), None)
    );
    assert!(facts(&engine, &faster).iter().any(|e| e.kind == "received"));
    assert!(facts(&engine, &lost).iter().any(|e| e.kind == "dropped"));
    assert!(facts(&engine, &delayed).is_empty());
    // Use a fresh node status observation for the next approved task.
    engine.inject("recover").unwrap();
    for _ in 0..60 {
        if engine.latest_evidence(source).is_some() {
            break;
        }
        engine.step();
    }
    let fresh = add(&mut engine, "request_observation", source);
    engine.review(&fresh, true).unwrap();
    engine.step();
    engine.step();
    assert_eq!(report_for(&engine, &fresh).version, 5);
    assert!(
        Engine::new(802)
            .current()
            .report_versions
            .iter()
            .all(|row| row.version == 1)
    );
}

#[test]
fn supplementary_samples_obey_noise_and_transport_latency() {
    for noisy in [false, true] {
        let mut engine = Engine::new(707);
        let link = engine
            .state
            .links
            .iter_mut()
            .find(|l| l.from == "pla-j20")
            .unwrap();
        link.quality = 1.0;
        link.latency_ticks = 7;
        if noisy {
            engine.inject("sensor_noise").unwrap();
        }
        let id = add(&mut engine, "request_observation", "pla-j20");
        engine.review(&id, true).unwrap();
        engine.step();
        engine.step();
        let message = engine
            .queue
            .iter()
            .find(|m| m.proposal_id.as_deref() == Some(&id))
            .unwrap()
            .clone();
        let confidence = message.observation.confidence;
        assert!((9..=11).contains(&message.due));
        if noisy {
            assert!((0.28..=0.56).contains(&confidence));
        } else {
            assert!((0.68..=0.93).contains(&confidence));
        }
        while engine.state.tick < message.due {
            engine.step();
        }
        let received = facts(&engine, &id)
            .into_iter()
            .find(|e| e.kind == "received")
            .unwrap();
        assert_eq!(
            received.evidence.as_ref().unwrap()[0].confidence,
            confidence
        );
    }
}

#[test]
fn proposal_archives_keep_window_start_evidence_then_prune_complete_groups() {
    let mut engine = Engine::new(708);
    let id = add(&mut engine, "hold", COMMAND);
    engine.review(&id, false).unwrap();
    let immutable = facts(&engine, &id).into_iter().cloned().collect::<Vec<_>>();
    for _ in 0..20 {
        engine.step();
    }
    for _ in 0..40 {
        let replacement = add(&mut engine, "hold", COMMAND);
        engine.review(&replacement, false).unwrap();
    }
    assert!(!engine.state.proposals.iter().any(|p| p.id == id));
    while engine.state.tick < 379 {
        engine.step();
    }
    assert_eq!(engine.state.history.first().unwrap().tick, 20);
    assert_eq!(
        facts(&engine, &id).into_iter().cloned().collect::<Vec<_>>(),
        immutable
    );
    assert!(
        !engine
            .state
            .observations
            .iter()
            .any(|o| o.id == immutable[0].evidence.as_ref().unwrap()[0].id)
    );
    engine.step();
    assert!(facts(&engine, &id).is_empty());
    for group in engine.decision_retention.keys() {
        assert!(facts(&engine, group).iter().any(|e| e.kind == "created"));
    }
    assert!(
        engine
            .state
            .decision_log
            .windows(2)
            .all(|pair| pair[0].seq < pair[1].seq)
    );
}

#[test]
fn paused_archive_capacity_rejects_new_groups_without_losing_old_evidence() {
    let mut engine = Engine::new(709);
    while engine.decision_retention.len() < MAX_DECISION_GROUPS {
        let id = add(&mut engine, "hold", COMMAND);
        engine.review(&id, false).unwrap();
    }
    let before = engine.snapshot();
    assert!(
        engine
            .add_model_proposals(vec![proposal(&engine, "hold", COMMAND)])
            .is_err()
    );
    assert_eq!(engine.snapshot(), before);
    assert_eq!(engine.state.history.len(), 1);
    assert_current_frame(&engine);
    assert_eq!(
        engine
            .state
            .decision_log
            .iter()
            .filter(|event| event.kind == "created")
            .count(),
        MAX_DECISION_GROUPS
    );
}
