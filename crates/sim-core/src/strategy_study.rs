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

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Material {
    #[default]
    Complete,
    Copy,
    Partial,
}

const SLOT_COUNT: usize = 4;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct FieldRecord {
    pub id: String,
    pub source_id: String,
    pub sampled_tick: u64,
    pub expected_samples: u8,
    pub recorded_samples: u8,
    pub finding: DeskClaim,
    /// Ordered sampling opportunities inside this record, indexed 1 through 4 in reports.
    pub slots: [bool; SLOT_COUNT],
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
        // Preserve the original sample count. Choose its positions with a separate
        // draw so changing the review policy or material cannot move a missing sample.
        let masks: Vec<u8> = (0u8..16)
            .filter(|mask| mask.count_ones() == u32::from(recorded_samples))
            .collect();
        let index = (draw(seed, source, tick, "sample-positions") * masks.len() as f64) as usize;
        let slots = std::array::from_fn(|slot| masks[index] & (1 << slot) != 0);
        Self {
            id: format!("field-{source}-{tick}"),
            source_id: source.into(),
            sampled_tick: tick,
            expected_samples: SLOT_COUNT as u8,
            recorded_samples,
            slots,
            finding: if slots.iter().all(|present| *present) {
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
pub struct SlotObservation {
    pub slot: u8,
    // An aggregate log can address this slot without reporting its individual result.
    pub present: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StudyReport {
    pub id: String,
    pub kind: &'static str,
    pub source_id: String,
    pub root_id: Option<String>,
    pub root_sampled_tick: u64,
    pub sampled_tick: u64,
    pub received_tick: u64,
    pub read_tick: Option<u64>,
    pub claim: Option<DeskClaim>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coverage: Option<Vec<SlotObservation>>,
}

// Content held at the source. Only its projection on receipt/read is public.
struct VerificationDocument {
    source_id: String,
    root_id: String,
    claim: Option<DeskClaim>,
    coverage: Vec<SlotObservation>,
}

impl VerificationDocument {
    fn collect(material: Material, supplement: &StudyReport, field: &FieldRecord) -> Self {
        if material == Material::Copy {
            // A second envelope copies the original window-level statement, including any
            // error. The underlying log supplies no reading for an individual slot.
            return Self {
                source_id: supplement.source_id.clone(),
                root_id: supplement.id.clone(),
                claim: supplement.claim,
                coverage: (1..=SLOT_COUNT as u8)
                    .map(|slot| SlotObservation {
                        slot,
                        present: None,
                    })
                    .collect(),
            };
        }
        let count = if material == Material::Partial {
            3
        } else {
            SLOT_COUNT
        };
        let coverage: Vec<_> = field.slots[..count]
            .iter()
            .enumerate()
            .map(|(i, present)| SlotObservation {
                slot: (i + 1) as u8,
                present: Some(*present),
            })
            .collect();
        let claim = if coverage.iter().any(|s| s.present == Some(false)) {
            Some(DeskClaim::Gap)
        } else if coverage.len() == SLOT_COUNT {
            Some(DeskClaim::Continuous)
        } else {
            None
        };
        Self {
            source_id: format!("counter-{}", supplement.source_id),
            root_id: format!(
                "counter-log-{}-{}",
                supplement.source_id, supplement.sampled_tick
            ),
            claim,
            coverage,
        }
    }
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
    pub unresolved_reason: Option<UnresolvedReason>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UnresolvedReason {
    NotReceived,
    SameSource,
    PartialCoverage,
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
    pub material: Material,
    pub link_events: Vec<StudyLink>,
    pub frames: Vec<StudyFrame>,
    pub settlement: Settlement,
}

impl BranchFrame {
    fn read_verification(&mut self, tick: u64, document: &VerificationDocument) {
        let [_, supplement, reply] = self.reports.as_mut_slice() else {
            return;
        };
        if reply.read_tick.is_some()
            || reply.received_tick >= tick
            || !tick.is_multiple_of(READ_INTERVAL)
        {
            return;
        }
        reply.read_tick = Some(tick);
        reply.source_id.clone_from(&document.source_id);
        reply.root_id = Some(document.root_id.clone());
        reply.coverage = Some(document.coverage.clone());
        reply.claim = document.claim;
        let shared_root = reply.root_id == supplement.root_id;
        let finding = if shared_root { None } else { reply.claim };
        let evidence = if shared_root {
            vec![supplement.id.clone(), reply.id.clone()]
        } else {
            vec![reply.id.clone()]
        };
        self.decide(
            tick,
            if finding.is_some() {
                "conclude"
            } else {
                "insufficient"
            },
            finding,
            evidence,
        );
    }

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
        let unresolved_reason = if conclusion.is_some() {
            None
        } else {
            Some(match self.reports.get(2) {
                None => UnresolvedReason::NotReceived,
                Some(reply) if reply.root_id == self.reports[1].root_id => {
                    UnresolvedReason::SameSource
                }
                Some(_) => UnresolvedReason::PartialCoverage,
            })
        };
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
            unresolved_reason,
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
            root_id: Some(r.root_id.clone()),
            root_sampled_tick: r.root_sampled_tick,
            sampled_tick: r.sampled_tick,
            received_tick: r.received_tick,
            read_tick: Some(event.tick),
            claim: r.claim,
            coverage: None,
        });
    }
    let [relay, supplement] = reports.as_slice() else {
        return Err("本案未完整保存两份冲突报告".into());
    };
    let ids = [&relay.id, &supplement.id];
    if relay.kind != "relay"
        || supplement.kind != "supplement"
        || supplement.root_id.as_deref() != Some(supplement.id.as_str())
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

/// Capture source-link switches through the exact rule-event cursor.
fn recorded_links(
    snapshot: &Snapshot,
    case_id: &str,
    supplement: &StudyReport,
    tick: u64,
    seq: u64,
) -> Result<Vec<StudyLink>, String> {
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
    Ok(tape)
}

fn schedule_link(tape: &mut Vec<StudyLink>, tick: u64, at_fork: bool, delivery: Delivery) {
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
}

struct RecordedFork {
    case_id: String,
    seq: u64,
    tick: u64,
    reports: Vec<StudyReport>,
    field: FieldRecord,
    recorded_links: Vec<StudyLink>,
}

impl StrategyStudy {
    /// Reuse the original conflict even when part of its history has since rolled out.
    /// Neither the descendant decisions nor the future scenario switches become inputs.
    pub fn with_conditions(&self, delivery: Delivery, material: Material) -> Result<Self, String> {
        let first = self.frames.first().ok_or("分岔原帧未保存")?;
        RecordedFork {
            case_id: self.case_id.clone(),
            seq: self.fork_seq,
            tick: self.fork_tick,
            reports: first.immediate.reports.clone(),
            field: self.settlement.field_record.clone(),
            recorded_links: self
                .link_events
                .iter()
                .filter(|e| e.origin == "recorded")
                .cloned()
                .collect(),
        }
        .run(delivery, material)
    }
}

/// An explicitly chosen counterfactual study. Never changes the supplied live engine.
pub fn run_study(
    snapshot: &Snapshot,
    case_id: &str,
    fork_seq: u64,
    delivery: Delivery,
    material: Material,
) -> Result<StrategyStudy, String> {
    let (tick, reports) = read_prefix(snapshot, case_id, fork_seq)?;
    let supplement = &reports[1];
    RecordedFork {
        case_id: case_id.into(),
        seq: fork_seq,
        tick,
        recorded_links: recorded_links(snapshot, case_id, supplement, tick, fork_seq)?,
        field: FieldRecord::recover(
            snapshot.seed,
            &supplement.source_id,
            supplement.sampled_tick,
        ),
        reports,
    }
    .run(delivery, material)
}

impl RecordedFork {
    fn run(self, delivery: Delivery, material: Material) -> Result<StrategyStudy, String> {
        if delivery != Delivery::Normal && material != Material::Complete {
            return Err("材料对照使用常规送达，以保持相同的收件与阅读时刻".into());
        }
        let Self {
            case_id,
            seq: fork_seq,
            tick: fork,
            reports,
            field,
            recorded_links: mut link_events,
        } = self;
        let end = fork.checked_add(STUDY_TICKS).ok_or("分岔时间超出范围")?;
        let [_, original] = reports.as_slice() else {
            return Err("分岔时的两份原件未完整保存".into());
        };
        let sampled_tick = original.sampled_tick;
        let source = original.source_id.clone();
        let document = VerificationDocument::collect(material, original, &field);
        let mut enabled = link_events
            .last()
            .ok_or("分岔时的来源链路开关未保存")?
            .enabled;
        schedule_link(&mut link_events, fork, enabled, delivery);
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
                            source_id: format!("verification-desk-{source}"),
                            root_id: None,
                            root_sampled_tick: sampled_tick,
                            sampled_tick,
                            received_tick: tick,
                            read_tick: None,
                            claim: None,
                            coverage: None,
                        });
                    }
                }
            }
            verify.read_verification(tick, &document);
            frames.push(StudyFrame {
                tick,
                immediate: immediate.clone(),
                verify: verify.clone(),
            });
        }
        Ok(StrategyStudy {
            kind: "c5isr-strategy-study",
            schema_version: 2,
            case_id,
            source_id: source,
            sampled_tick,
            fork_tick: fork,
            fork_seq,
            end_tick: end,
            delivery,
            material,
            link_events,
            frames,
            settlement: Settlement {
                immediate: immediate.score(&field, fork, end),
                verify: verify.score(&field, fork, end),
                field_record: field,
            },
        })
    }
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
        let normal = run_study(snapshot, &case, seq, Delivery::Normal, Material::Complete).unwrap();
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
                reports[0].root_id.as_deref(),
                reports[0].read_tick,
                reports[0].claim
            ),
            (Some("obs-000002"), Some(6), Some(DeskClaim::Continuous))
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
            let study = run_study(snapshot, &case, seq, delivery, Material::Complete).unwrap();
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
                    assert_eq!(
                        reply.root_id.as_deref(),
                        opened.then_some("counter-log-pla-kj700-3")
                    );
                    assert_eq!(reply.coverage.is_some(), opened);
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
                    decision_tick: Some(12),
                    unresolved_reason: None,
                }
            );
            assert_eq!(
                study.settlement.verify,
                Score {
                    wrong: 0,
                    unresolved: u8::from(read.is_none()),
                    wait_ticks: read.unwrap_or(30) - 12,
                    verification_requests: 1,
                    decision_tick: read,
                    unresolved_reason: read.is_none().then_some(UnresolvedReason::NotReceived),
                }
            );
        }
    }

    #[test]
    fn same_timing_and_record_only_the_opened_documents_differ() {
        let (engine, case) = replay_outage(20261022);
        let snapshot = engine.current();
        let seq = conflict_seq(snapshot, &case).unwrap();
        let run = |material| run_study(snapshot, &case, seq, Delivery::Normal, material).unwrap();
        let complete = run(Material::Complete);
        let copy = run(Material::Copy);
        let partial = run(Material::Partial);
        assert_eq!(complete.settlement.field_record.slots, [true; 4]);
        for study in [&complete, &copy, &partial] {
            assert_eq!(study.schema_version, 2);
            assert_eq!(study.link_events, complete.link_events);
            assert_eq!(
                study.settlement.field_record,
                complete.settlement.field_record
            );
            assert_eq!(study.settlement.immediate, complete.settlement.immediate);
            for (frame, baseline) in study.frames.iter().zip(&complete.frames) {
                assert_eq!(frame.immediate, baseline.immediate);
                if frame.tick < 18 {
                    assert_eq!(frame.verify, baseline.verify);
                }
            }
            let received = &study.frames[3].verify;
            let envelope = &received.reports[2];
            assert_eq!((envelope.received_tick, envelope.read_tick), (15, None));
            assert_eq!(envelope.source_id, "verification-desk-pla-kj700");
            assert_eq!(envelope.root_id, None);
            assert_eq!(envelope.coverage, None);
            assert_eq!(envelope.claim, None);
            assert_eq!(received.decisions.len(), 1);
            let read = &study.frames[6].verify;
            let reply = &read.reports[2];
            assert_eq!(reply.read_tick, Some(18));
            assert_eq!(
                read.decisions[1].read_ids,
                read.reports
                    .iter()
                    .map(|r| r.id.clone())
                    .collect::<Vec<_>>()
            );
            // A subsequent frame retains the exact record of the first reading.
            assert_eq!(study.frames.last().unwrap().verify, *read);
        }
        let complete_reply = &complete.frames[6].verify.reports[2];
        let copy_desk = &copy.frames[6].verify;
        let supplement = &copy_desk.reports[1];
        let copied = &copy_desk.reports[2];
        assert_ne!(copied.id, supplement.id);
        assert_eq!(
            (&copied.source_id, &copied.root_id, copied.claim),
            (
                &supplement.source_id,
                &supplement.root_id,
                Some(DeskClaim::Gap)
            )
        );
        let copy_coverage = copied.coverage.as_ref().unwrap();
        assert_eq!(copy_coverage.len(), 4);
        assert!(
            copy_coverage
                .iter()
                .enumerate()
                .all(|(i, s)| s.slot as usize == i + 1 && s.present.is_none())
        );
        let held = &copy_desk.decisions[1];
        assert_eq!((held.action, held.finding), ("insufficient", None));
        assert_eq!(
            held.evidence_ids,
            [supplement.id.clone(), copied.id.clone()]
        );
        let partial_desk = &partial.frames[6].verify;
        let subset = &partial_desk.reports[2];
        assert_eq!(subset.root_id, complete_reply.root_id);
        assert_ne!(subset.root_id, supplement.root_id);
        assert_eq!(
            subset.coverage.as_deref().unwrap(),
            &complete_reply.coverage.as_deref().unwrap()[..3]
        );
        assert!(
            subset
                .coverage
                .as_deref()
                .unwrap()
                .iter()
                .all(|slot| slot.present == Some(true))
        );
        assert_eq!(subset.claim, None);
        assert_eq!(partial_desk.decisions[1].action, "insufficient");
        assert_eq!(partial_desk.decisions[1].evidence_ids, [subset.id.clone()]);
        for (score, reason) in [
            (&copy.settlement.verify, UnresolvedReason::SameSource),
            (
                &partial.settlement.verify,
                UnresolvedReason::PartialCoverage,
            ),
        ] {
            assert_eq!(score.unresolved_reason, Some(reason));
            assert_eq!(
                (
                    score.wrong,
                    score.unresolved,
                    score.decision_tick,
                    score.wait_ticks,
                    score.verification_requests
                ),
                (0, 1, None, 18, 1)
            );
        }
        for material in [Material::Copy, Material::Partial] {
            for delivery in [Delivery::Delayed, Delivery::Lost] {
                assert!(run_study(snapshot, &case, seq, delivery, material).is_err());
            }
        }
    }

    #[test]
    fn partial_observations_can_prove_a_gap_inside_their_own_coverage() {
        let (engine, case) = replay_outage(20261026);
        let snapshot = engine.current();
        let seq = conflict_seq(snapshot, &case).unwrap();
        let study = run_study(snapshot, &case, seq, Delivery::Normal, Material::Partial).unwrap();
        let field = &study.settlement.field_record;
        assert_eq!(field.recorded_samples, 2);
        assert_eq!(field.slots.iter().filter(|present| **present).count(), 2);
        let desk = &study.frames[6].verify;
        let reply = &desk.reports[2];
        assert_eq!(reply.claim, Some(DeskClaim::Gap));
        let observed = reply.coverage.as_ref().unwrap();
        assert!(observed.iter().any(|s| s.present == Some(false)));
        assert_eq!(observed.len(), 3);
        for s in observed {
            assert_eq!(s.present, Some(field.slots[usize::from(s.slot) - 1]));
        }
        assert_eq!(desk.decisions[1].action, "conclude");
        assert_eq!(desk.decisions[1].finding, Some(DeskClaim::Gap));
        assert_eq!(desk.decisions[1].evidence_ids, [reply.id.clone()]);
        assert_eq!(study.settlement.verify.unresolved_reason, None);
        assert_eq!(study.settlement.verify.decision_tick, Some(18));
    }

    #[test]
    fn two_different_fourth_samples_produce_identical_first_three_observations() {
        let (engine, case) = replay_outage(20261022);
        let snapshot = engine.current();
        let seq = conflict_seq(snapshot, &case).unwrap();
        let (_, reports) = read_prefix(snapshot, &case, seq).unwrap();
        let supplement = &reports[1];
        let full = FieldRecord::recover(
            snapshot.seed,
            &supplement.source_id,
            supplement.sampled_tick,
        );
        let fourth_missing = FieldRecord {
            slots: [true, true, true, false],
            recorded_samples: 3,
            finding: DeskClaim::Gap,
            ..full.clone()
        };
        let first = VerificationDocument::collect(Material::Partial, supplement, &full);
        let second = VerificationDocument::collect(Material::Partial, supplement, &fourth_missing);
        assert_eq!(first.coverage, second.coverage);
        assert_eq!((first.claim, second.claim), (None, None));
        let complete =
            VerificationDocument::collect(Material::Complete, supplement, &fourth_missing);
        assert_eq!(complete.claim, Some(DeskClaim::Gap));
    }

    #[test]
    fn rejects_non_conflict_and_preserves_exact_same_tick_cutoff() {
        let (mut engine, case) = replay_outage(20261022);
        let seq = conflict_seq(engine.current(), &case).unwrap();
        let run = run_study(
            engine.current(),
            &case,
            seq,
            Delivery::Normal,
            Material::Complete,
        )
        .unwrap();
        assert!(
            run_study(
                engine.current(),
                &case,
                seq - 1,
                Delivery::Normal,
                Material::Complete
            )
            .is_err()
        );
        assert!(
            run_study(
                engine.current(),
                "other",
                seq,
                Delivery::Normal,
                Material::Complete
            )
            .is_err()
        );
        let report = run.frames[0].immediate.reports[1].id.clone();
        engine
            .record_desk_judgment(&case, seq - 1, &[report])
            .unwrap();
        assert!(
            run_study(
                engine.current(),
                &case,
                seq + 1,
                Delivery::Normal,
                Material::Complete
            )
            .is_err()
        );
        engine.inject("link_loss").unwrap();
        engine.inject("recover").unwrap();
        assert_eq!(
            run,
            run_study(
                engine.current(),
                &case,
                seq,
                Delivery::Normal,
                Material::Complete
            )
            .unwrap()
        );
        let (agree, id) = replay_outage(20261023);
        assert_eq!(conflict_seq(agree.current(), &id), None);
    }

    #[test]
    fn fork_needs_its_actual_outage_even_while_the_conflict_frame_is_retained() {
        let (mut engine, case) = replay_outage(20261022);
        let seq = conflict_seq(engine.current(), &case).unwrap();
        let original = run_study(
            engine.current(),
            &case,
            seq,
            Delivery::Normal,
            Material::Complete,
        )
        .unwrap();
        let delayed = run_study(
            engine.current(),
            &case,
            seq,
            Delivery::Delayed,
            Material::Complete,
        )
        .unwrap();
        let partial = run_study(
            engine.current(),
            &case,
            seq,
            Delivery::Normal,
            Material::Partial,
        )
        .unwrap();
        let mut incomplete = engine.snapshot();
        incomplete.history.retain(|f| f.tick != 5);
        assert!(
            run_study(
                &incomplete,
                &case,
                seq,
                Delivery::Normal,
                Material::Complete
            )
            .unwrap_err()
            .contains("帧不完整")
        );
        while engine.current().tick < crate::MAX_HISTORY as u64 - 1 {
            engine.step();
        }
        assert_eq!(engine.current().history[0].tick, 0);
        assert_eq!(
            run_study(
                engine.current(),
                &case,
                seq,
                Delivery::Normal,
                Material::Complete
            )
            .unwrap(),
            original
        );
        engine.step();
        assert_eq!(engine.current().history[0].tick, 1);
        assert_eq!(
            delayed
                .with_conditions(Delivery::Normal, Material::Partial)
                .unwrap(),
            partial
        );
        assert_eq!(
            partial
                .with_conditions(Delivery::Delayed, Material::Complete)
                .unwrap(),
            delayed
        );
        assert_eq!(conflict_seq(engine.current(), &case), Some(seq));
        assert!(
            run_study(
                engine.current(),
                &case,
                seq,
                Delivery::Delayed,
                Material::Complete
            )
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
        let study = run_study(
            engine.current(),
            &case,
            seq,
            Delivery::Lost,
            Material::Complete,
        )
        .unwrap();
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
