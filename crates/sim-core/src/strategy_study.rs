//! Fork two offline review policies at an actual, recorded desk conflict.
//! The counter record is keyed by source and sampling tick. Reading a report,
//! requesting another copy, or changing its transport cannot change that record.
use super::{
    DeskActor, DeskClaim, DeskFinding, DeskReportKind, Snapshot, live_desk::READ_INTERVAL,
    next_random,
};
use serde::{Deserialize, Serialize};

const STUDY_TICKS: u64 = 18;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Delivery {
    Normal,
    Delayed,
    Lost,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct FieldRecord {
    pub id: String,
    pub source_id: String,
    pub sampled_tick: u64,
    pub expected_samples: u8,
    pub recorded_samples: u8,
    pub finding: DeskClaim,
}

fn stable_hash(key: &str) -> u64 {
    // FNV-1a is deliberately independent of Rust's randomized HashMap keys.
    key.bytes().fold(0xcbf2_9ce4_8422_2325, |value, byte| {
        (value ^ u64::from(byte)).wrapping_mul(0x100_0000_01b3)
    })
}

fn draw(seed: u64, source: &str, tick: u64, channel: &str) -> f64 {
    let mut key = seed
        ^ stable_hash(source)
        ^ tick.wrapping_mul(0x9e37_79b9_7f4a_7c15)
        ^ stable_hash(channel);
    next_random(&mut key)
}

fn recorded_count(seed: u64, source: &str, tick: u64) -> u8 {
    let count = draw(seed, source, tick, "sample-counter");
    if count < 0.5 { (count * 8.0) as u8 } else { 4 }
}

impl FieldRecord {
    fn recover(seed: u64, source: &str, tick: u64) -> Self {
        let recorded_samples = recorded_count(seed, source, tick);
        Self {
            id: format!("field-{source}-{tick}"),
            source_id: source.into(),
            sampled_tick: tick,
            expected_samples: 4,
            recorded_samples,
            finding: if recorded_samples == 4 {
                DeskClaim::Continuous
            } else {
                DeskClaim::Gap
            },
        }
    }
}

/// The ordinary status report may misread its source's raw sample counter.
/// Both it and a later audit refer to the exact same collector and time slot.
pub(crate) fn edition_claim(seed: u64, source: &str, tick: u64) -> DeskClaim {
    let missing = recorded_count(seed, source, tick) < 4;
    let readout_error = draw(seed, source, tick, "edition") < 0.25;
    if missing ^ readout_error {
        DeskClaim::Gap
    } else {
        DeskClaim::Continuous
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StudyLink {
    pub tick: u64,
    pub enabled: bool,
    pub origin: &'static str,
    pub seq: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StudyReport {
    pub id: String,
    pub kind: &'static str,
    pub source_id: String,
    pub root_id: String,
    pub root_sampled_tick: u64,
    pub sampled_tick: u64,
    pub received_tick: u64,
    pub read_tick: Option<u64>,
    pub claim: Option<DeskClaim>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StudyDecision {
    pub tick: u64,
    pub action: &'static str,
    pub finding: Option<DeskClaim>,
    pub read_ids: Vec<String>,
    pub evidence_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BranchFrame {
    pub reports: Vec<StudyReport>,
    pub decisions: Vec<StudyDecision>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StudyFrame {
    pub tick: u64,
    pub immediate: BranchFrame,
    pub verify: BranchFrame,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Score {
    pub wrong: u8,
    pub unresolved: u8,
    pub wait_ticks: u64,
    pub verification_requests: u8,
    pub decision_tick: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Settlement {
    pub field_record: FieldRecord,
    pub immediate: Score,
    pub verify: Score,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StrategyStudy {
    pub kind: &'static str,
    pub schema_version: u8,
    pub case_id: String,
    pub source_id: String,
    pub sampled_tick: u64,
    pub fork_tick: u64,
    pub fork_seq: u64,
    pub end_tick: u64,
    pub delivery: Delivery,
    pub link_events: Vec<StudyLink>,
    pub frames: Vec<StudyFrame>,
    pub settlement: Settlement,
}

impl BranchFrame {
    fn decide(
        &mut self,
        tick: u64,
        action: &'static str,
        finding: Option<DeskClaim>,
        evidence_ids: Vec<String>,
    ) {
        self.decisions.push(StudyDecision {
            tick,
            action,
            finding,
            evidence_ids,
            read_ids: self
                .reports
                .iter()
                .filter(|r| r.read_tick.is_some())
                .map(|r| r.id.clone())
                .collect(),
        });
    }

    fn score(&self, field: &FieldRecord, fork: u64, end: u64) -> Score {
        let conclusion = self.decisions.iter().find(|d| d.action == "conclude");
        let decision_tick = conclusion.map(|d| d.tick);
        Score {
            wrong: u8::from(conclusion.is_some_and(|d| d.finding != Some(field.finding))),
            unresolved: u8::from(conclusion.is_none()),
            wait_ticks: decision_tick.unwrap_or(end) - fork,
            verification_requests: self
                .decisions
                .iter()
                .filter(|d| d.action == "request_verification")
                .count() as u8,
            decision_tick,
        }
    }
}

fn read_prefix(
    snapshot: &Snapshot,
    case: &str,
    seq: u64,
) -> Result<(u64, Vec<StudyReport>), String> {
    let anchor = snapshot
        .decision_log
        .iter()
        .find(|e| e.seq == seq && e.proposal_id == case)
        .ok_or("没有找到本案的分岔事件")?;
    let judgment = anchor
        .desk_judgment
        .as_ref()
        .filter(|j| {
            anchor.kind == "desk_judged"
                && j.actor == DeskActor::Rule
                && j.finding == DeskFinding::Conflict
        })
        .ok_or("分岔点须是已读转述和补报形成的规则冲突判断")?;
    let mut reports = Vec::new();
    for event in snapshot
        .decision_log
        .iter()
        .take_while(|e| e.seq < seq)
        .filter(|e| e.proposal_id == case && e.kind == "desk_read")
    {
        let r = event
            .desk_report
            .as_ref()
            .ok_or("分岔所需的阅读记录不完整")?;
        reports.push(StudyReport {
            id: r.id.clone(),
            kind: match r.kind {
                DeskReportKind::Relay => "relay",
                DeskReportKind::Supplement => "supplement",
            },
            source_id: r.source_id.clone(),
            root_id: r.root_id.clone(),
            root_sampled_tick: r.root_sampled_tick,
            sampled_tick: r.sampled_tick,
            received_tick: r.received_tick,
            read_tick: Some(event.tick),
            claim: r.claim,
        });
    }
    let [relay, supplement] = reports.as_slice() else {
        return Err("本案未完整保存两份冲突报告".into());
    };
    let ids = [&relay.id, &supplement.id];
    if relay.kind != "relay"
        || supplement.kind != "supplement"
        || relay.claim.is_none()
        || supplement.claim.is_none()
        || relay.claim == supplement.claim
        || relay.source_id != supplement.source_id
        || relay.sampled_tick != supplement.sampled_tick
        || !judgment.read_ids.iter().eq(ids)
        || !judgment.evidence_ids.iter().eq(ids)
    {
        return Err("分岔时的阅读清单、材料或引用不匹配".into());
    }
    Ok((anchor.tick, reports))
}

/// An offline frame at the start of the retained window cannot establish when
/// the source went offline. Require the actual outage that buffered this report.
fn check_outage(
    snapshot: &Snapshot,
    case_id: &str,
    supplement: &StudyReport,
    fork: u64,
    seq: u64,
    tape: &[StudyLink],
) -> Result<(), String> {
    let mut transport = snapshot
        .decision_log
        .iter()
        .take_while(|e| e.seq < seq)
        .filter(|e| {
            e.proposal_id == case_id
                && e.report_id.as_deref() == Some(&supplement.id)
                && e.sampled_tick == Some(supplement.sampled_tick)
        });
    let buffered = transport
        .find(|e| e.kind == "buffered")
        .ok_or("没有保留本份补报的首次暂存记录")?;
    let received = transport
        .find(|e| e.kind == "received" && e.tick == supplement.received_tick)
        .ok_or("没有保留暂存补报送达审核席的传输记录")?;
    let outage = tape
        .iter()
        .rev()
        .find(|e| e.seq.is_some_and(|s| s < buffered.seq))
        .filter(|e| !e.enabled)
        .ok_or("首次暂存时的断链变更已超出记录窗口，无法重建本案")?;
    if !tape
        .iter()
        .any(|e| e.enabled && e.seq.is_some_and(|s| s > buffered.seq && s < received.seq))
    {
        return Err("没有保留本次暂存后、补报送达前的链路恢复记录".into());
    }
    let start = outage.tick.min(supplement.sampled_tick);
    if !snapshot
        .history
        .iter()
        .map(|f| f.tick)
        .filter(|t| (start..=fork).contains(t))
        .eq(start..=fork)
    {
        return Err("本案采样、断链到分岔之间的回放帧不完整".into());
    }
    Ok(())
}

/// Carry the recorded on/off transitions through the exact fork cursor, then
/// extend one external link tape used by both policies. A request cannot change it.
fn link_tape(
    snapshot: &Snapshot,
    case_id: &str,
    supplement: &StudyReport,
    tick: u64,
    seq: u64,
    delivery: Delivery,
) -> Result<(bool, Vec<StudyLink>), String> {
    let frame = snapshot
        .history
        .iter()
        .find(|f| f.tick == tick && f.decision_seq >= seq)
        .ok_or("分岔帧已超出保留窗口")?;
    let link = frame
        .links
        .iter()
        .find(|l| l.from == supplement.source_id)
        .ok_or("分岔帧没有该来源的链路")?;
    let at_fork = frame
        .link_changes
        .iter()
        .find(|e| e.link_id == link.id && e.seq > seq)
        .map_or(link.enabled, |e| e.before.enabled);
    let mut tape = Vec::new();
    for f in snapshot.history.iter().take_while(|f| f.tick <= tick) {
        for e in &f.link_changes {
            if e.link_id == link.id && e.seq <= seq && e.before.enabled != e.after.enabled {
                tape.push(StudyLink {
                    tick: f.tick,
                    enabled: e.after.enabled,
                    seq: Some(e.seq),
                    origin: "recorded",
                });
            }
        }
    }
    check_outage(snapshot, case_id, supplement, tick, seq, &tape)?;
    let mut schedule = |offset, enabled| {
        tape.push(StudyLink {
            tick: tick + offset,
            enabled,
            seq: None,
            origin: "scenario",
        })
    };
    if !at_fork {
        schedule(1, true);
    }
    if delivery != Delivery::Normal {
        schedule(2, false);
    }
    if delivery == Delivery::Delayed {
        schedule(11, true);
    }
    Ok((at_fork, tape))
}

/// An explicitly chosen counterfactual study. Never changes the supplied live engine.
pub fn run_study(
    snapshot: &Snapshot,
    case_id: &str,
    fork_seq: u64,
    delivery: Delivery,
) -> Result<StrategyStudy, String> {
    let (fork, reports) = read_prefix(snapshot, case_id, fork_seq)?;
    let end = fork.checked_add(STUDY_TICKS).ok_or("分岔时间超出范围")?;
    let source = reports[1].source_id.clone();
    let sampled_tick = reports[1].sampled_tick;
    let field = FieldRecord::recover(snapshot.seed, &source, sampled_tick);
    let (mut enabled, link_events) =
        link_tape(snapshot, case_id, &reports[1], fork, fork_seq, delivery)?;
    let mut immediate = BranchFrame {
        reports,
        decisions: vec![],
    };
    let mut verify = immediate.clone();
    let supplement = &immediate.reports[1];
    immediate.decide(
        fork,
        "conclude",
        supplement.claim,
        vec![supplement.id.clone()],
    );
    verify.decide(
        fork,
        "request_verification",
        None,
        verify.reports.iter().map(|r| r.id.clone()).collect(),
    );

    let mut frames = Vec::new();
    let mut request_arrived = false;
    let mut transit_steps = 0;
    for tick in fork..=end {
        if let Some(change) = link_events
            .iter()
            .find(|e| e.origin == "scenario" && e.tick == tick)
        {
            enabled = change.enabled;
        }
        if tick > fork && verify.reports.len() == 2 {
            if !enabled {
                transit_steps = 0;
            } else if !request_arrived {
                request_arrived = true;
            } else {
                transit_steps += 1;
                if transit_steps == 2 {
                    verify.reports.push(StudyReport {
                        id: format!("verification-{case_id}"),
                        kind: "verification",
                        source_id: format!("counter-{source}"),
                        root_id: field.id.clone(),
                        root_sampled_tick: sampled_tick,
                        sampled_tick,
                        received_tick: tick,
                        read_tick: None,
                        claim: None,
                    });
                }
            }
        }
        if let Some(reply) = verify.reports.get_mut(2)
            && reply.read_tick.is_none()
            && reply.received_tick < tick
            && tick.is_multiple_of(READ_INTERVAL)
        {
            reply.read_tick = Some(tick);
            reply.claim = Some(field.finding);
            let evidence = vec![reply.id.clone()];
            let finding = reply.claim;
            verify.decide(tick, "conclude", finding, evidence);
        }
        frames.push(StudyFrame {
            tick,
            immediate: immediate.clone(),
            verify: verify.clone(),
        });
    }
    Ok(StrategyStudy {
        kind: "c5isr-strategy-study",
        schema_version: 1,
        case_id: case_id.into(),
        source_id: source,
        sampled_tick,
        fork_tick: fork,
        fork_seq,
        end_tick: end,
        delivery,
        link_events,
        frames,
        settlement: Settlement {
            immediate: immediate.score(&field, fork, end),
            verify: verify.score(&field, fork, end),
            field_record: field,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Engine;

    fn replay_outage(seed: u64) -> (Engine, String) {
        let mut engine = Engine::new(seed);
        engine.inject("link_loss").unwrap();
        engine.step();
        let case = engine
            .current()
            .proposals
            .iter()
            .find(|p| p.action == "request_observation" && p.subject_id == "pla-kj700")
            .unwrap()
            .id
            .clone();
        engine.review(&case, true).unwrap();
        while engine.current().tick < 6 {
            engine.step();
        }
        engine.inject("recover").unwrap();
        while engine.current().tick < 12 {
            engine.step();
        }
        (engine, case)
    }

    fn conflict_seq(snapshot: &Snapshot, case: &str) -> Option<u64> {
        snapshot
            .decision_log
            .iter()
            .find(|e| {
                e.proposal_id == case
                    && e.desk_judgment.as_ref().is_some_and(|j| {
                        j.actor == DeskActor::Rule && j.finding == DeskFinding::Conflict
                    })
            })
            .map(|e| e.seq)
    }

    #[test]
    fn three_transport_schedules_replay_one_frozen_case_and_one_counter_record() {
        let (engine, case) = replay_outage(20261022);
        let snapshot = engine.current();
        let seq = conflict_seq(snapshot, &case).unwrap();
        let normal = run_study(snapshot, &case, seq, Delivery::Normal).unwrap();
        assert_eq!((normal.fork_tick, normal.end_tick), (12, 30));
        assert_eq!(
            (
                normal.settlement.field_record.expected_samples,
                normal.settlement.field_record.recorded_samples
            ),
            (4, 4)
        );
        assert_eq!(
            normal.settlement.field_record.finding,
            DeskClaim::Continuous
        );
        let reports = &normal.frames[0].immediate.reports;
        assert_eq!(
            (
                reports[0].root_id.as_str(),
                reports[0].read_tick,
                reports[0].claim
            ),
            ("obs-000002", Some(6), Some(DeskClaim::Continuous))
        );
        assert_eq!(
            (
                reports[1].id.as_str(),
                reports[1].received_tick,
                reports[1].read_tick,
                reports[1].claim
            ),
            ("obs-000013", 9, Some(12), Some(DeskClaim::Gap))
        );
        let both = vec![reports[0].id.clone(), reports[1].id.clone()];
        for (delivery, received, read) in [
            (Delivery::Normal, Some(15), Some(18)),
            (Delivery::Delayed, Some(24), Some(27)),
            (Delivery::Lost, None, None),
        ] {
            let study = run_study(snapshot, &case, seq, delivery).unwrap();
            assert_eq!(
                study.settlement.field_record,
                normal.settlement.field_record
            );
            assert!(
                study
                    .link_events
                    .iter()
                    .any(|e| e.origin == "recorded" && e.tick == 0 && !e.enabled)
            );
            assert!(
                study
                    .link_events
                    .iter()
                    .any(|e| e.origin == "recorded" && e.tick == 6 && e.enabled)
            );
            assert_eq!(study.frames.len(), 19);
            for frame in study.frames {
                assert_eq!(frame.immediate, normal.frames[0].immediate);
                assert_eq!(frame.immediate.decisions[0].read_ids, both);
                assert_eq!(frame.immediate.decisions[0].evidence_ids, both[1..]);
                assert_eq!(&frame.verify.reports[..2], reports);
                let request = &frame.verify.decisions[0];
                assert_eq!(
                    (request.action, request.tick, request.finding),
                    ("request_verification", 12, None)
                );
                assert_eq!(request.evidence_ids, both);
                let visible = received.is_some_and(|t| t <= frame.tick);
                let opened = read.is_some_and(|t| t <= frame.tick);
                assert_eq!(frame.verify.reports.len(), 2 + usize::from(visible));
                assert_eq!(frame.verify.decisions.len(), 1 + usize::from(opened));
                if visible {
                    let reply = &frame.verify.reports[2];
                    assert_eq!(reply.root_id, normal.settlement.field_record.id);
                    assert_eq!(Some(reply.received_tick), received);
                    assert_eq!(reply.read_tick, read.filter(|_| opened));
                    assert_eq!(reply.claim, opened.then_some(DeskClaim::Continuous));
                    if opened {
                        let concluded = &frame.verify.decisions[1];
                        assert_eq!(concluded.evidence_ids, [reply.id.clone()]);
                        assert_eq!(
                            concluded.read_ids,
                            [both[0].clone(), both[1].clone(), reply.id.clone()]
                        );
                    }
                }
            }
            assert_eq!(
                study.settlement.immediate,
                Score {
                    wrong: 1,
                    unresolved: 0,
                    wait_ticks: 0,
                    verification_requests: 0,
                    decision_tick: Some(12)
                }
            );
            assert_eq!(
                study.settlement.verify,
                Score {
                    wrong: 0,
                    unresolved: u8::from(read.is_none()),
                    wait_ticks: read.unwrap_or(30) - 12,
                    verification_requests: 1,
                    decision_tick: read
                }
            );
        }
    }

    #[test]
    fn rejects_non_conflict_and_preserves_exact_same_tick_cutoff() {
        let (mut engine, case) = replay_outage(20261022);
        let seq = conflict_seq(engine.current(), &case).unwrap();
        let run = run_study(engine.current(), &case, seq, Delivery::Normal).unwrap();
        assert!(run_study(engine.current(), &case, seq - 1, Delivery::Normal).is_err());
        assert!(run_study(engine.current(), "other", seq, Delivery::Normal).is_err());
        let report = run.frames[0].immediate.reports[1].id.clone();
        engine
            .record_desk_judgment(&case, seq - 1, &[report])
            .unwrap();
        assert!(run_study(engine.current(), &case, seq + 1, Delivery::Normal).is_err());
        engine.inject("link_loss").unwrap();
        engine.inject("recover").unwrap();
        assert_eq!(
            run,
            run_study(engine.current(), &case, seq, Delivery::Normal).unwrap()
        );
        let (agree, id) = replay_outage(20261023);
        assert_eq!(conflict_seq(agree.current(), &id), None);
    }

    #[test]
    fn fork_needs_its_actual_outage_even_while_the_conflict_frame_is_retained() {
        let (mut engine, case) = replay_outage(20261022);
        let seq = conflict_seq(engine.current(), &case).unwrap();
        let original = run_study(engine.current(), &case, seq, Delivery::Normal).unwrap();
        let mut incomplete = engine.snapshot();
        incomplete.history.retain(|f| f.tick != 5);
        assert!(
            run_study(&incomplete, &case, seq, Delivery::Normal)
                .unwrap_err()
                .contains("帧不完整")
        );
        while engine.current().tick < crate::MAX_HISTORY as u64 - 1 {
            engine.step();
        }
        assert_eq!(engine.current().history[0].tick, 0);
        assert_eq!(
            run_study(engine.current(), &case, seq, Delivery::Normal).unwrap(),
            original
        );
        engine.step();
        assert_eq!(engine.current().history[0].tick, 1);
        assert_eq!(conflict_seq(engine.current(), &case), Some(seq));
        assert!(
            run_study(engine.current(), &case, seq, Delivery::Delayed)
                .unwrap_err()
                .contains("断链变更已超出记录窗口")
        );
        assert!(
            original
                .link_events
                .iter()
                .any(|e| e.tick == 0 && !e.enabled && e.origin == "recorded")
        );
    }

    #[test]
    fn a_different_real_fork_can_have_missing_samples_and_a_correct_immediate_conclusion() {
        let (engine, case) = replay_outage(20261026);
        let seq = conflict_seq(engine.current(), &case).unwrap();
        let study = run_study(engine.current(), &case, seq, Delivery::Lost).unwrap();
        let field = study.settlement.field_record;
        assert_eq!(
            (
                field.recorded_samples,
                field.expected_samples,
                field.finding
            ),
            (2, 4, DeskClaim::Gap)
        );
        assert_eq!(study.settlement.immediate.wrong, 0);
        assert_eq!(study.settlement.verify.unresolved, 1);
    }
}
