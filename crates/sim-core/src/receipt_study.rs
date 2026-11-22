//! Two counterfactual field states on the same recorded outage and transport schedule.
//! The centre knows only its local request/link observations and the receipts in its inbox.
use super::{COMMAND, Snapshot, live_desk::expected_sample_tick};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReceiptDelivery {
    Delivered,
    Lost,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldStatus {
    SampledBuffered,
    NotSampled,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
pub struct Request {
    pub id: String,
    pub approved_tick: u64,
    pub approval_seq: u64,
}

/// Structured status read automatically on arrival. Its claim is about `as_of_tick`.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
pub struct StatusReceipt {
    pub id: String,
    pub case_id: String,
    pub source_id: String,
    pub status: FieldStatus,
    pub as_of_tick: u64,
    pub sampled_tick: Option<u64>,
    pub sent_tick: u64,
    pub received_tick: u64,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
pub struct Knowledge {
    pub status: FieldStatus,
    pub as_of_tick: u64,
    pub known_tick: u64,
    pub receipt_id: String,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
pub struct Center {
    pub link_enabled: bool,
    pub request: Option<Request>,
    pub expected_tick: Option<u64>,
    pub receipts: Vec<StatusReceipt>,
    pub knowledge: Option<Knowledge>,
}

impl Center {
    // Only actual inbox contents can establish or change field status.
    fn project_inbox(&mut self, received: Option<StatusReceipt>) {
        self.knowledge = received.as_ref().map(|r| Knowledge {
            status: r.status,
            as_of_tick: r.as_of_tick,
            known_tick: r.received_tick,
            receipt_id: r.id.clone(),
        });
        self.receipts = received.into_iter().collect();
    }
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
pub struct ReceiptFrame {
    pub tick: u64,
    pub buffered: Center,
    pub not_sampled: Center,
}

/// Director's record, kept separate from both centres.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
pub struct Audit {
    pub status: FieldStatus,
    pub as_of_tick: u64,
    pub sampled_tick: Option<u64>,
    pub sent_tick: u64,
    pub received_tick: Option<u64>,
    pub receipt_id: String,
}

impl Audit {
    fn received_by(&self, at: u64, case_id: &str, source_id: &str) -> Option<StatusReceipt> {
        let received_tick = self.received_tick.filter(|tick| *tick <= at)?;
        Some(StatusReceipt {
            id: self.receipt_id.clone(),
            case_id: case_id.into(),
            source_id: source_id.into(),
            status: self.status,
            as_of_tick: self.as_of_tick,
            sampled_tick: self.sampled_tick,
            sent_tick: self.sent_tick,
            received_tick,
        })
    }
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
pub struct FieldAudit {
    pub buffered: Audit,
    pub not_sampled: Audit,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
pub struct ReceiptStudy {
    pub kind: &'static str,
    pub schema_version: u8,
    pub case_id: String,
    pub source_id: String,
    pub approval_seq: u64,
    pub start_tick: u64,
    pub end_tick: u64,
    pub delivery: ReceiptDelivery,
    pub frames: Vec<ReceiptFrame>,
    pub field_audit: FieldAudit,
}

impl ReceiptStudy {
    /// A sibling uses the originally frozen link and request observations, even if the
    /// live window has rolled since it was recorded. Only the return channel changes.
    pub fn with_delivery(&self, delivery: ReceiptDelivery) -> Self {
        self.clone().apply_delivery(delivery)
    }

    fn apply_delivery(mut self, delivery: ReceiptDelivery) -> Self {
        self.delivery = delivery;
        let arrival = (delivery == ReceiptDelivery::Delivered).then_some(self.end_tick);
        self.field_audit.buffered.received_tick = arrival;
        self.field_audit.not_sampled.received_tick = arrival;
        for f in &mut self.frames {
            for (center, audit) in [
                (&mut f.buffered, &self.field_audit.buffered),
                (&mut f.not_sampled, &self.field_audit.not_sampled),
            ] {
                center.project_inbox(audit.received_by(f.tick, &self.case_id, &self.source_id));
            }
        }
        self
    }
}

/// The parent's supplementary report supplies the measured buffer, restoration, final
/// send and delivery times. The two status receipts are synthetic messages on this tape,
/// distinct from that report and scoped to the approved case.
pub fn run_study(
    snapshot: &Snapshot,
    case_id: &str,
    approval_seq: u64,
    delivery: ReceiptDelivery,
) -> Result<ReceiptStudy, String> {
    let mut events = snapshot
        .decision_log
        .iter()
        .filter(|e| e.proposal_id == case_id);
    let proposal = events
        .find(|e| e.kind == "created")
        .and_then(|e| e.proposal.as_ref())
        .filter(|p| p.action == "request_observation")
        .ok_or("没有找到本案的补报请求")?;
    let approval = events
        .find(|e| e.kind == "approved" && e.seq == approval_seq)
        .ok_or("没有找到本案对应的批准事件")?;
    let execution = events
        .find(|e| e.kind == "executing")
        .ok_or("请求尚未开始执行")?;
    let expected = expected_sample_tick(execution.tick);
    let buffered = events
        .find(|e| matches!(e.kind.as_str(), "buffered" | "sent" | "dropped" | "expired"))
        .filter(|e| e.kind == "buffered" && e.sampled_tick == Some(e.tick))
        .ok_or("需要原件在采样时断链暂存的记录")?;
    let report_id = buffered.report_id.as_deref().ok_or("缺少原件编号")?;
    let transport = events.filter(|e| {
        e.report_id.as_deref() == Some(report_id) && e.sampled_tick == Some(buffered.tick)
    });
    let receipt = transport
        .clone()
        .find(|e| matches!(e.kind.as_str(), "received" | "expired" | "dropped"))
        .filter(|e| {
            e.kind == "received"
                && e.evidence.iter().flatten().any(|o| {
                    o.id == report_id
                        && o.source_id == proposal.subject_id
                        && o.observed_tick == buffered.tick
                        && o.received_tick == e.tick
                })
        })
        .ok_or("本案尚无可复用的实际送达记录")?;
    let sent = transport
        .take_while(|e| e.seq < receipt.seq)
        .filter(|e| matches!(e.kind.as_str(), "sent" | "buffered"))
        .last()
        .filter(|e| e.kind == "sent")
        .ok_or("补报送达前缺少实际发送事件")?;
    let last_frame = snapshot
        .history
        .iter()
        .find(|f| f.tick == receipt.tick)
        .ok_or("本案收件帧已移出保留窗口")?;
    let link = last_frame
        .links
        .iter()
        .find(|l| l.from == proposal.subject_id && l.to == COMMAND)
        .ok_or("缺少来源至中心的链路")?;
    let switches = snapshot
        .history
        .iter()
        .flat_map(|f| f.link_changes.iter().map(move |c| (f.tick, c)))
        .filter(|(_, c)| c.link_id == link.id && c.before.enabled != c.after.enabled);
    let (outage_tick, _) = switches
        .clone()
        .rfind(|(_, c)| c.seq < buffered.seq)
        .filter(|(_, c)| !c.after.enabled)
        .ok_or("首次暂存前的断链事件未保留")?;
    if !switches
        .clone()
        .rfind(|(_, c)| c.seq < sent.seq)
        .is_some_and(|(_, c)| c.seq > buffered.seq && c.after.enabled)
    {
        return Err("缺少暂存后、最终发送前的恢复记录".into());
    }
    let start = outage_tick.min(approval.tick);
    let end = receipt.tick;
    let span = snapshot
        .history
        .iter()
        .filter(|f| (start..=end).contains(&f.tick));
    if !span.clone().map(|f| f.tick).eq(start..=end) {
        return Err("从断链及批准到送达的历史帧不完整".into());
    }
    let request = Request {
        id: case_id.into(),
        approved_tick: approval.tick,
        approval_seq,
    };
    let mut frames = Vec::new();
    for f in span {
        let frame_link = f
            .links
            .iter()
            .find(|l| l.id == link.id)
            .ok_or("帧中缺少中心本端链路记录")?;
        // The terminal observation cuts at delivery. A later switch while the
        // clock is paused can rewrite that tick's end-of-frame link snapshot.
        let cutoff_seq = f.decision_seq.min(receipt.seq);
        let enabled = f
            .link_changes
            .iter()
            .find(|c| c.link_id == link.id && c.seq > cutoff_seq)
            .map_or(frame_link.enabled, |c| c.before.enabled);
        let local = Center {
            link_enabled: enabled,
            request: (cutoff_seq >= approval_seq).then(|| request.clone()),
            expected_tick: (cutoff_seq >= execution.seq).then_some(expected),
            receipts: Vec::new(),
            knowledge: None,
        };
        frames.push(ReceiptFrame {
            tick: f.tick,
            buffered: local.clone(),
            not_sampled: local,
        });
    }
    let observed = Audit {
        status: FieldStatus::SampledBuffered,
        sampled_tick: Some(buffered.tick),
        as_of_tick: buffered.tick,
        sent_tick: sent.tick,
        received_tick: None,
        receipt_id: format!("ack-{case_id}-buffered"),
    };
    let pending = Audit {
        status: FieldStatus::NotSampled,
        sampled_tick: None,
        receipt_id: format!("ack-{case_id}-not-sampled"),
        ..observed.clone()
    };
    Ok(ReceiptStudy {
        kind: "c5isr-receipt-study",
        schema_version: 1,
        case_id: case_id.into(),
        source_id: proposal.subject_id.clone(),
        approval_seq,
        start_tick: start,
        end_tick: end,
        delivery,
        frames,
        field_audit: FieldAudit {
            buffered: observed,
            not_sampled: pending,
        },
    }
    .apply_delivery(delivery))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Engine;

    fn recovered_case() -> (Engine, String, u64) {
        let mut engine = Engine::new(20261022);
        engine.inject("link_loss").unwrap();
        engine.step();
        let id = engine
            .current()
            .proposals
            .iter()
            .find(|p| p.action == "request_observation" && p.subject_id == "pla-kj700")
            .unwrap()
            .id
            .clone();
        engine.review(&id, true).unwrap();
        let seq = engine.current().decision_log.last().unwrap().seq;
        while engine.current().tick < 6 {
            engine.step();
        }
        engine.inject("recover").unwrap();
        (engine, id, seq)
    }

    fn recorded_case() -> (Engine, String, u64) {
        let (mut engine, id, seq) = recovered_case();
        while engine.current().tick < 9 {
            engine.step();
        }
        (engine, id, seq)
    }

    #[test]
    fn only_a_delivered_status_receipt_distinguishes_the_two_local_views() {
        let (mut engine, id, seq) = recorded_case();
        let study = run_study(engine.current(), &id, seq, ReceiptDelivery::Delivered).unwrap();
        assert_eq!((study.start_tick, study.end_tick), (0, 9));
        for frame in &study.frames[..9] {
            assert_eq!(frame.buffered, frame.not_sampled);
            assert!(frame.buffered.receipts.is_empty());
            assert!(frame.buffered.knowledge.is_none());
            assert_eq!(
                frame.buffered.request.as_ref().map(|r| r.approval_seq),
                (frame.tick >= 1).then_some(seq)
            );
            assert_eq!(frame.buffered.expected_tick, (frame.tick >= 2).then_some(3));
            assert_eq!(frame.buffered.link_enabled, frame.tick >= 6);
        }
        let last = study.frames.last().unwrap();
        for (center, status, sampled, suffix) in [
            (
                &last.buffered,
                FieldStatus::SampledBuffered,
                Some(3),
                "buffered",
            ),
            (
                &last.not_sampled,
                FieldStatus::NotSampled,
                None,
                "not-sampled",
            ),
        ] {
            let [receipt] = center.receipts.as_slice() else {
                panic!("expected exactly one delivered receipt")
            };
            assert_eq!(receipt.id, format!("ack-{id}-{suffix}"));
            assert_eq!((receipt.status, receipt.sampled_tick), (status, sampled));
            assert_eq!(
                (receipt.as_of_tick, receipt.sent_tick, receipt.received_tick),
                (3, 6, 9)
            );
            let knowledge = center.knowledge.as_ref().unwrap();
            assert_eq!(knowledge.receipt_id, receipt.id);
            assert_eq!(
                (knowledge.status, knowledge.as_of_tick, knowledge.known_tick),
                (status, 3, 9)
            );
        }
        for _ in 0..3 {
            engine.step();
        }
        assert_eq!(
            study,
            run_study(engine.current(), &id, seq, ReceiptDelivery::Delivered).unwrap()
        );
    }

    #[test]
    fn a_second_outage_uses_the_final_send_and_delivery_of_the_same_report() {
        let (mut engine, id, seq) = recovered_case();
        engine.step();
        engine.inject("link_loss").unwrap();
        engine.step();
        engine.inject("recover").unwrap();
        while engine.current().tick < 13 {
            engine.step();
        }
        let s = run_study(engine.current(), &id, seq, ReceiptDelivery::Delivered).unwrap();
        let sends: Vec<u64> = engine
            .current()
            .decision_log
            .iter()
            .filter(|e| e.proposal_id == id && e.kind == "sent")
            .map(|e| e.tick)
            .collect();
        assert_eq!(sends, [6, 8]);
        assert_eq!(s.field_audit.buffered.as_of_tick, 3);
        assert_eq!(s.field_audit.buffered.sent_tick, 8);
        assert!(s.end_tick > 8);
        for f in s.frames.iter().filter(|f| f.tick < s.end_tick) {
            assert_eq!(f.buffered, f.not_sampled);
            assert!(f.buffered.receipts.is_empty());
        }
    }

    #[test]
    fn final_link_observation_is_frozen_at_receipt_even_if_that_tick_changes_again() {
        let (mut engine, id, seq) = recorded_case();
        let before = run_study(engine.current(), &id, seq, ReceiptDelivery::Delivered).unwrap();
        for cause in ["link_loss", "recover", "link_loss"] {
            engine.inject(cause).unwrap();
            assert_eq!(
                before,
                run_study(engine.current(), &id, seq, ReceiptDelivery::Delivered).unwrap()
            );
        }
        assert!(
            !engine
                .current()
                .links
                .iter()
                .find(|l| l.from == before.source_id)
                .unwrap()
                .enabled
        );
        assert!(before.frames.last().unwrap().buffered.link_enabled);
    }

    #[test]
    fn no_receipt_leaves_both_pending_even_after_reconnection_and_the_final_send() {
        let (engine, id, seq) = recorded_case();
        let delivered = run_study(engine.current(), &id, seq, ReceiptDelivery::Delivered).unwrap();
        let lost = delivered.with_delivery(ReceiptDelivery::Lost);
        assert_eq!(
            lost,
            run_study(engine.current(), &id, seq, ReceiptDelivery::Lost).unwrap()
        );
        for f in &lost.frames {
            assert_eq!(f.buffered, f.not_sampled);
            assert!(f.buffered.knowledge.is_none() && f.buffered.receipts.is_empty());
        }
        assert_ne!(
            lost.field_audit.buffered.status,
            lost.field_audit.not_sampled.status
        );
        assert_eq!(
            lost.field_audit.buffered.sent_tick,
            lost.field_audit.not_sampled.sent_tick
        );
        assert_eq!(lost.field_audit.buffered.received_tick, None);
        assert_eq!(delivered, lost.with_delivery(ReceiptDelivery::Delivered));
    }

    #[test]
    fn only_an_anchored_outage_and_actual_arrival_can_supply_the_transport_schedule() {
        let (engine, id, seq) = recorded_case();
        assert!(run_study(engine.current(), &id, seq + 1, ReceiptDelivery::Delivered).is_err());
        assert!(
            run_study(
                engine.current(),
                "unrelated",
                seq,
                ReceiptDelivery::Delivered
            )
            .is_err()
        );
        for missing in ["buffered", "sent", "received"] {
            let mut snap = engine.snapshot();
            snap.decision_log
                .retain(|e| !(e.proposal_id == id && e.kind == missing));
            assert!(run_study(&snap, &id, seq, ReceiptDelivery::Delivered).is_err());
        }
        let mut clipped = engine.snapshot();
        clipped.history.remove(0);
        assert!(run_study(&clipped, &id, seq, ReceiptDelivery::Delivered).is_err());
    }
}
