//! The reviewer's view of synthetic collector continuity during an uplink outage.
//! Receipt, reading, and assessment each append their own immutable, ordered fact.
use super::{DecisionEvent, Engine, Observation};
use serde::{Deserialize, Serialize};

const READ_INTERVAL: u64 = 3;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeskReportKind {
    Relay,
    Supplement,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeskClaim {
    Continuous,
    Gap,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct DeskReport {
    pub id: String,
    pub source_id: String,
    pub kind: DeskReportKind,
    /// For a relay this is the original edition already held by the centre.
    pub root_id: String,
    pub root_sampled_tick: u64,
    /// Both statements in a case address this same sampling tick.
    pub sampled_tick: u64,
    pub received_tick: u64,
    /// Filled only at a desk reading, never on the receipt envelope.
    pub claim: Option<DeskClaim>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeskActor {
    Rule,
    Human,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeskFinding {
    Continuous,
    Gap,
    Conflict,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct DeskJudgment {
    pub actor: DeskActor,
    pub finding: DeskFinding,
    pub read_ids: Vec<String>,
    pub evidence_ids: Vec<String>,
}

impl DeskJudgment {
    fn from_reports(actor: DeskActor, read: &[&DeskReport], cited: &[&DeskReport]) -> Self {
        // Both callers select at least one actual reading from this case.
        let first = cited[0].claim.expect("desk reading carries a claim");
        let finding = if cited.iter().any(|r| r.claim != Some(first)) {
            DeskFinding::Conflict
        } else {
            match first {
                DeskClaim::Continuous => DeskFinding::Continuous,
                DeskClaim::Gap => DeskFinding::Gap,
            }
        };
        Self {
            actor,
            finding,
            read_ids: read.iter().map(|r| r.id.clone()).collect(),
            evidence_ids: cited.iter().map(|r| r.id.clone()).collect(),
        }
    }
}

impl Engine {
    fn has_desk_case(&self, case_id: &str) -> bool {
        self.state
            .decision_log
            .iter()
            .rev()
            .any(|e| e.proposal_id == case_id && e.kind == "desk_received")
    }

    pub(super) fn receive_desk_relay(&mut self, case_id: &str, sample: &Observation) {
        if self.has_desk_case(case_id) {
            return;
        }
        // Traverse only editions issued before this sample. A delayed older
        // packet can be interrupted after a newer edition has already arrived.
        let issued = self
            .state
            .report_versions
            .iter()
            .position(|r| r.report_id == sample.id)
            .expect("buffered supplement has a retained edition");
        let cached = self.state.report_versions[..issued]
            .iter()
            .rev()
            .find(|r| r.source_id == sample.source_id && r.center_received_tick.is_some())
            .expect("own source has a previously received edition");
        self.enqueue_desk_report(
            case_id,
            DeskReport {
                id: format!("relay-{case_id}"),
                source_id: sample.source_id.clone(),
                kind: DeskReportKind::Relay,
                root_id: cached.report_id.clone(),
                root_sampled_tick: cached.sampled_tick,
                sampled_tick: sample.observed_tick,
                received_tick: self.state.tick,
                claim: None,
            },
        );
    }

    pub(super) fn receive_desk_supplement(&mut self, case_id: &str, sample: &Observation) {
        if self.has_desk_case(case_id) {
            self.enqueue_desk_report(
                case_id,
                DeskReport {
                    id: sample.id.clone(),
                    source_id: sample.source_id.clone(),
                    kind: DeskReportKind::Supplement,
                    root_id: sample.id.clone(),
                    root_sampled_tick: sample.observed_tick,
                    sampled_tick: sample.observed_tick,
                    received_tick: sample.received_tick,
                    claim: None,
                },
            );
        }
    }

    fn enqueue_desk_report(&mut self, case_id: &str, mut report: DeskReport) {
        self.push_decision_event(DecisionEvent {
            desk_report: Some(report.clone()),
            ..DecisionEvent::new(self.state.tick, case_id, "desk_received")
        });
        report.claim = Some(self.edition_claims[&report.root_id]);
        self.desk_inbox.push_back((case_id.into(), report));
    }

    pub(super) fn read_next_desk_report(&mut self) {
        if !self.state.tick.is_multiple_of(READ_INTERVAL)
            || self
                .desk_inbox
                .front()
                .is_none_or(|(_, r)| r.received_tick >= self.state.tick)
        {
            return;
        }
        let (case_id, report) = self.desk_inbox.pop_front().expect("eligible inbox head");
        self.push_decision_event(DecisionEvent {
            desk_report: Some(report),
            ..DecisionEvent::new(self.state.tick, &case_id, "desk_read")
        });
        let read = self.desk_readings(&case_id);
        let judgment = DeskJudgment::from_reports(DeskActor::Rule, &read, &read);
        self.append_desk_judgment(&case_id, judgment);
    }

    fn desk_readings(&self, case_id: &str) -> Vec<&DeskReport> {
        self.state
            .decision_log
            .iter()
            .filter(|e| e.proposal_id == case_id && e.kind == "desk_read")
            .filter_map(|e| e.desk_report.as_ref())
            .collect()
    }

    fn append_desk_judgment(&mut self, case_id: &str, judgment: DeskJudgment) {
        self.push_decision_event(DecisionEvent {
            desk_judgment: Some(judgment),
            ..DecisionEvent::new(self.state.tick, case_id, "desk_judged")
        });
    }

    /// Record one human choice of evidence per reading. The expected sequence
    /// belongs to the most recent reading in this case, not to the entire run.
    pub fn record_desk_judgment(
        &mut self,
        case_id: &str,
        expected_read_seq: u64,
        evidence_ids: &[String],
    ) -> Result<(), String> {
        let latest = self
            .state
            .decision_log
            .iter()
            .rfind(|e| e.proposal_id == case_id && e.kind == "desk_read")
            .ok_or("审核席尚无该组已读报告")?;
        if latest.seq != expected_read_seq {
            return Err("本组已读报告发生变化，请根据最新阅读记录重新选择".into());
        }
        if self
            .state
            .decision_log
            .iter()
            .rev()
            .take_while(|e| e.seq > latest.seq)
            .any(|e| {
                e.proposal_id == case_id
                    && e.desk_judgment
                        .as_ref()
                        .is_some_and(|j| j.actor == DeskActor::Human)
            })
        {
            return Err("本组已按当前阅读记录登记过人工判断".into());
        }
        let read = self.desk_readings(case_id);
        if evidence_ids.is_empty() || evidence_ids.len() > read.len() {
            return Err("请从本组已读报告中选取判断依据".into());
        }
        let mut cited = Vec::with_capacity(evidence_ids.len());
        for (i, id) in evidence_ids.iter().enumerate() {
            let report = read
                .iter()
                .copied()
                .find(|r| r.id == *id)
                .ok_or("引用的报告尚未阅读或属于其他复核组")?;
            if evidence_ids[..i].contains(id) {
                return Err("判断依据包含重复引用".into());
            }
            cited.push(report);
        }
        let judgment = DeskJudgment::from_reports(DeskActor::Human, &read, &cited);
        self.append_desk_judgment(case_id, judgment);
        self.replace_current_frame();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn start_case(seed: u64) -> (Engine, String) {
        let mut engine = Engine::new(seed);
        engine.inject("link_loss").unwrap();
        engine.step();
        let case = engine
            .state
            .proposals
            .iter()
            .find(|p| p.subject_id == "pla-kj700" && p.action == "request_observation")
            .unwrap()
            .id
            .clone();
        engine.review(&case, true).unwrap();
        (engine, case)
    }

    fn advance(engine: &mut Engine, to: u64) {
        while engine.state.tick < to {
            engine.step();
        }
    }

    fn entries<'a>(engine: &'a Engine, case: &str, kind: &str) -> Vec<&'a DecisionEvent> {
        engine
            .state
            .decision_log
            .iter()
            .filter(|e| e.proposal_id == case && e.kind == kind)
            .collect()
    }

    #[test]
    fn default_case_freezes_two_read_epochs_and_only_the_citations_selected() {
        let (mut engine, case) = start_case(20261022);
        advance(&mut engine, 3);
        let received = entries(&engine, &case, "desk_received")[0];
        let relay = received.desk_report.clone().unwrap();
        assert_eq!(received.tick, 3);
        assert_eq!(relay.root_id, "obs-000002");
        assert_eq!(relay.root_sampled_tick, 0);
        assert_eq!(relay.sampled_tick, 3);
        assert_eq!(relay.claim, None);
        assert!(entries(&engine, &case, "desk_read").is_empty());
        let before = engine.snapshot();
        assert!(
            engine
                .record_desk_judgment(&case, received.seq, &[relay.id.clone()])
                .is_err()
        );
        assert_eq!(engine.snapshot(), before);

        advance(&mut engine, 6);
        let first_read = entries(&engine, &case, "desk_read")[0].clone();
        assert_eq!(first_read.tick, 6);
        assert_eq!(
            first_read.desk_report.unwrap().claim,
            Some(DeskClaim::Continuous)
        );
        let first_rule = entries(&engine, &case, "desk_judged")[0].clone();
        assert_eq!(first_rule.seq, first_read.seq + 1);
        let cited_relay = vec![relay.id.clone()];
        engine
            .record_desk_judgment(&case, first_read.seq, &cited_relay)
            .unwrap();
        let human = entries(&engine, &case, "desk_judged")[1].clone();
        assert_eq!(
            human.desk_judgment.as_ref().unwrap().actor,
            DeskActor::Human
        );
        assert_eq!(human.desk_judgment.as_ref().unwrap().read_ids, cited_relay);
        assert_eq!(engine.state.history.last().unwrap().decision_seq, human.seq);
        assert!(
            engine
                .record_desk_judgment(&case, first_read.seq, &cited_relay)
                .is_err()
        );

        engine.inject("recover").unwrap();
        advance(&mut engine, 9);
        let supplement = entries(&engine, &case, "desk_received")[1]
            .desk_report
            .clone()
            .unwrap();
        assert_eq!(supplement.claim, None);
        assert_eq!((supplement.sampled_tick, supplement.received_tick), (3, 9));
        assert_eq!(supplement.id, "obs-000013");
        assert_eq!(supplement.root_id, supplement.id);
        assert_eq!(entries(&engine, &case, "desk_read").len(), 1);

        advance(&mut engine, 12);
        let read = entries(&engine, &case, "desk_read")[1];
        let seq = read.seq;
        assert_eq!(read.tick, 12);
        assert_eq!(
            read.desk_report.as_ref().unwrap().claim,
            Some(DeskClaim::Gap)
        );
        let rules = entries(&engine, &case, "desk_judged");
        assert_eq!(rules[0], &first_rule);
        assert_eq!(rules[1], &human);
        assert_eq!(rules[2].seq, seq + 1);
        let judgment = rules[2].desk_judgment.as_ref().unwrap();
        assert_eq!(judgment.finding, DeskFinding::Conflict);
        assert_eq!(
            judgment.evidence_ids,
            [relay.id.clone(), supplement.id.clone()]
        );
        assert_eq!(judgment.evidence_ids, judgment.read_ids);
        let before = engine.snapshot();
        assert!(
            engine
                .record_desk_judgment(&case, first_read.seq, &cited_relay)
                .is_err()
        );
        for invalid in [
            vec![],
            vec!["wrong-case".into()],
            vec![relay.id.clone(), relay.id.clone()],
        ] {
            assert!(engine.record_desk_judgment(&case, seq, &invalid).is_err());
        }
        assert_eq!(engine.snapshot(), before);
        engine
            .record_desk_judgment(&case, seq, std::slice::from_ref(&supplement.id))
            .unwrap();
        let last = entries(&engine, &case, "desk_judged")[3]
            .desk_judgment
            .as_ref()
            .unwrap();
        assert_eq!(last.read_ids, [relay.id, supplement.id.clone()]);
        assert_eq!(last.evidence_ids, [supplement.id]);
        assert_eq!(last.finding, DeskFinding::Gap);
        assert_eq!(engine.state.metrics, before.metrics);
        assert_eq!(engine.state.proposals, before.proposals);
    }

    #[test]
    fn agreement_and_failed_delivery_follow_the_actual_transport() {
        for lost in [false, true] {
            let (mut engine, case) = start_case(20261023);
            advance(&mut engine, 6);
            let link = engine
                .state
                .links
                .iter_mut()
                .find(|l| l.from == "pla-kj700")
                .unwrap();
            link.enabled = true;
            link.quality = if lost { 0.0 } else { 1.0 };
            advance(&mut engine, 30);
            let read = entries(&engine, &case, "desk_read");
            if lost {
                assert_eq!(entries(&engine, &case, "dropped").len(), 1);
                assert_eq!(entries(&engine, &case, "desk_received").len(), 1);
                assert_eq!(read.len(), 1);
            } else {
                assert_eq!(read.len(), 2);
                assert_eq!(
                    read[0].desk_report.as_ref().unwrap().claim,
                    read[1].desk_report.as_ref().unwrap().claim
                );
                assert_ne!(
                    entries(&engine, &case, "desk_judged")[1]
                        .desk_judgment
                        .as_ref()
                        .unwrap()
                        .finding,
                    DeskFinding::Conflict
                );
            }
            advance(&mut engine, 430);
            assert_eq!(
                engine.edition_claims.len(),
                engine.state.report_versions.len()
            );
            assert!(engine.desk_inbox.is_empty());
        }
    }
}
