//! Paired review of conflicting reports about one synthetic collector in T+0..1.
//! The external report tape is fixed before either desk processes a single report.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, VecDeque};

const MAX_FORK: u32 = 36;
const MAX_INTERVAL: u32 = 6;
const MAX_BATCH: u32 = 32;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LabConfig {
    pub seed: u32,
    pub read_interval: u32,
    pub fork_tick: Option<u32>,
    pub cited_ids: Option<Vec<String>>,
}

impl Default for LabConfig {
    fn default() -> Self {
        Self {
            seed: 20_261_022,
            read_interval: 3,
            fork_tick: None,
            cited_ids: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct LabReport {
    pub id: String,
    pub source: String,
    pub root_id: String,
    pub kind: String,
    pub claim: String,
    pub period_start: u32,
    pub period_end: u32,
    pub issued_tick: u32,
    pub received_tick: u32,
    pub read_tick: Option<u32>,
    pub derived_from: Option<String>,
    pub revises: Option<String>,
    pub note: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct LabDecision {
    pub tick: u32,
    pub actor: String,
    pub action: String,
    pub claim: String,
    pub evidence_ids: Vec<String>,
    pub read_ids: Vec<String>,
    pub independent_roots: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
pub struct LabMetrics {
    /// Count of frame ends through this tick with a conflict in effective read evidence.
    pub conflict_ticks: u32,
    /// Conclusions which cited a report (or its quotation) subsequently corrected
    /// in evidence the desk has now read. A request for review is not a conclusion.
    pub corrected_approvals: u32,
    pub review_requests: u32,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct LabFrame {
    pub tick: u32,
    pub reports: Vec<LabReport>,
    pub queue_ids: Vec<String>,
    pub active_ids: Vec<String>,
    pub independent_roots: Vec<String>,
    pub conflict: bool,
    pub decisions: Vec<LabDecision>,
    pub metrics: LabMetrics,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct LabRun {
    pub frames: Vec<LabFrame>,
    pub metrics: LabMetrics,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct LabArchive {
    pub kind: String,
    pub schema_version: u32,
    pub config: LabConfig,
    pub fork_tick: u32,
    pub end_tick: u32,
    pub immediate: LabRun,
    pub review: LabRun,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct BatchRow {
    pub seed: u32,
    pub immediate: LabMetrics,
    pub review: LabMetrics,
}

/// Fixed statements observed in the same sampling window. R2 quotes R1, and
/// both R4 and the on-demand R5 trace the correction back to that original.
enum Statement {
    Collector,
    Relay,
    SelfCheck,
    Correction,
    Clarification,
}

impl Statement {
    fn report(self, issued_tick: u32, received_tick: u32) -> LabReport {
        let (id, source, root, kind, claim, quoted, revised, note) = match self {
            Self::Collector => (
                "R1",
                "现场采集器",
                "R1",
                "direct",
                "normal",
                None,
                None,
                "采集器状态页显示采样正常。",
            ),
            Self::Relay => (
                "R2",
                "中继记录席",
                "R1",
                "relay",
                "normal",
                Some("R1"),
                None,
                "转述现场采集器 R1 的状态记录，本席没有独立采样。",
            ),
            Self::SelfCheck => (
                "R3",
                "独立自检器",
                "R3",
                "self_check",
                "interrupted",
                None,
                None,
                "独立计数器发现该时段样本缺失。",
            ),
            Self::Correction => (
                "R4",
                "现场采集器",
                "R1",
                "correction",
                "interrupted",
                None,
                Some("R1"),
                "例行核对本地采样日志后更正 R1。原状态页显示了缓存值，该时段采样实际中断。",
            ),
            Self::Clarification => (
                "R5",
                "现场采集器",
                "R1",
                "clarification",
                "interrupted",
                None,
                Some("R1"),
                "应审核席复核请求，现场比对原始计数并更正 R1。状态页沿用了缓存值。",
            ),
        };
        LabReport {
            id: id.into(),
            source: source.into(),
            root_id: root.into(),
            kind: kind.into(),
            claim: claim.into(),
            period_start: 0,
            period_end: 1,
            issued_tick,
            received_tick,
            read_tick: None,
            derived_from: quoted.map(str::to_owned),
            revises: revised.map(str::to_owned),
            note: note.into(),
        }
    }
}

struct Scenario {
    common: Vec<LabReport>,
    /// Drawn up front so a policy never shifts another policy's random stream.
    reply_delay: u32,
}

impl Scenario {
    fn new(seed: u32) -> Self {
        let mut state = u64::from(seed);
        let mut jitter = |range: u32| (super::next_random(&mut state) * f64::from(range)) as u32;
        let direct = 2 + jitter(2);
        let relay = direct + 1 + jitter(2);
        let independent = relay + 1 + jitter(3);
        let correction = 18 + jitter(8);
        Self {
            common: vec![
                Statement::Collector.report(1, direct),
                Statement::Relay.report(direct, relay),
                Statement::SelfCheck.report(2, independent),
                Statement::Correction.report(correction - 2, correction),
            ],
            reply_delay: 2 + jitter(4),
        }
    }

    fn recommended_fork(&self, interval: u32) -> u32 {
        // First instant the original and its relay have both left the FIFO.
        let first_read = self.common[0].received_tick.next_multiple_of(interval);
        (first_read + interval).max(self.common[1].received_tick.next_multiple_of(interval))
    }
}

fn report_ids(reports: &[&LabReport]) -> Vec<String> {
    reports.iter().map(|report| report.id.clone()).collect()
}

fn independent_roots(reports: &[&LabReport]) -> Vec<String> {
    reports
        .iter()
        .map(|report| report.root_id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

/// Select the latest read revision of each primary source. Quotations of an
/// obsolete edition stay in the inbox but cease to support the current claim.
fn effective<'a>(read: &[&'a LabReport]) -> Vec<&'a LabReport> {
    read.iter()
        .copied()
        .filter(|report| {
            let latest = read
                .iter()
                .filter(|other| other.root_id == report.root_id && other.revises.is_some())
                .max_by_key(|other| (other.issued_tick, &other.id));
            latest.is_none_or(|revision| {
                report.derived_from.as_ref().unwrap_or(&report.id) == &revision.id
            })
        })
        .collect()
}

fn consensus(reports: &[&LabReport]) -> &'static str {
    match reports.first() {
        Some(first) if reports.iter().all(|r| r.claim == first.claim) => {
            if first.claim == "normal" {
                "normal"
            } else {
                "interrupted"
            }
        }
        _ => "undetermined",
    }
}

fn citations<'a>(
    active: &[&'a LabReport],
    selection: Option<&[String]>,
) -> Result<Vec<&'a LabReport>, String> {
    if active.is_empty() {
        return Err("分岔时审核席尚无已读报告，请选择较晚的仿真步。".into());
    }
    let Some(ids) = selection else {
        return Ok(active.to_vec());
    };
    if ids.is_empty()
        || ids.len() > active.len()
        || ids.iter().collect::<BTreeSet<_>>().len() != ids.len()
    {
        return Err("引用必须是非空且无重复的有效已读报告。".into());
    }
    ids.iter()
        .map(|id| {
            active
                .iter()
                .copied()
                .find(|report| &report.id == id)
                .ok_or_else(|| "引用包含本帧未知、未读或已被更正的报告。".to_string())
        })
        .collect()
}

fn decision(
    tick: u32,
    actor: &str,
    action: &str,
    read: &[&LabReport],
    cited: &[&LabReport],
) -> LabDecision {
    LabDecision {
        tick,
        actor: actor.into(),
        action: action.into(),
        claim: if action == "request_review" {
            "undetermined"
        } else {
            consensus(cited)
        }
        .into(),
        evidence_ids: report_ids(cited),
        read_ids: report_ids(read),
        independent_roots: independent_roots(cited),
    }
}

/// The retrospective counter becomes visible only after the desk reads the
/// correcting report. Count each affected approval once, regardless of copies.
fn is_corrected(decision: &LabDecision, read: &[&LabReport]) -> bool {
    decision.action == "conclude"
        && read.iter().any(|revision| {
            let Some(revised_id) = revision.revises.as_ref() else {
                return false;
            };
            revision.read_tick.is_some_and(|tick| tick > decision.tick)
                && read.iter().any(|cited| {
                    decision.evidence_ids.contains(&cited.id)
                        && cited.derived_from.as_ref().unwrap_or(&cited.id) == revised_id
                })
        })
}

#[derive(Clone, Default)]
struct Desk {
    reports: Vec<LabReport>,
    unread: VecDeque<usize>,
    decisions: Vec<LabDecision>,
    metrics: LabMetrics,
}

impl Desk {
    fn receive(&mut self, report: &LabReport) {
        self.unread.push_back(self.reports.len());
        self.reports.push(report.clone());
    }

    fn advance(&mut self, tick: u32, interval: u32) -> Option<&str> {
        if tick.is_multiple_of(interval)
            && let Some(index) = self.unread.pop_front()
        {
            self.reports[index].read_tick = Some(tick);
            Some(&self.reports[index].id)
        } else {
            None
        }
    }

    fn frame(
        &mut self,
        tick: u32,
        action: Option<(&str, &str, Option<&[String]>)>,
    ) -> Result<LabFrame, String> {
        let read: Vec<_> = self
            .reports
            .iter()
            .filter(|r| r.read_tick.is_some())
            .collect();
        let active = effective(&read);
        if let Some((actor, action, selection)) = action {
            let cited = citations(&active, selection)?;
            self.decisions
                .push(decision(tick, actor, action, &read, &cited));
            self.metrics.review_requests += u32::from(action == "request_review");
        }
        let conflict = !active.is_empty() && consensus(&active) == "undetermined";
        self.metrics.conflict_ticks += u32::from(conflict);
        self.metrics.corrected_approvals = self
            .decisions
            .iter()
            .filter(|d| is_corrected(d, &read))
            .count() as u32;
        Ok(LabFrame {
            tick,
            reports: self.reports.clone(),
            queue_ids: self
                .unread
                .iter()
                .map(|i| self.reports[*i].id.clone())
                .collect(),
            active_ids: report_ids(&active),
            independent_roots: independent_roots(&active),
            conflict,
            decisions: self.decisions.clone(),
            metrics: self.metrics.clone(),
        })
    }
}

pub fn run_lab(config: &LabConfig) -> Result<LabArchive, String> {
    if !(1..=MAX_INTERVAL).contains(&config.read_interval) {
        return Err("审核间隔应为 1 至 6 个仿真步。".into());
    }
    let scenario = Scenario::new(config.seed);
    let fork = config
        .fork_tick
        .unwrap_or_else(|| scenario.recommended_fork(config.read_interval));
    if !(1..=MAX_FORK).contains(&fork) {
        return Err("自选分岔时刻应为 T+1 至 T+36。".into());
    }
    // A late fork still leaves time to receive and read every possible reply.
    let end = MAX_FORK + 2 * MAX_INTERVAL;
    let mut desk = Desk::default();
    let mut prefix = Vec::new();
    for tick in 0..fork {
        for report in scenario.common.iter().filter(|r| r.received_tick == tick) {
            desk.receive(report);
        }
        desk.advance(tick, config.read_interval);
        prefix.push(desk.frame(tick, None)?);
    }
    let branch = |review: bool| -> Result<LabRun, String> {
        let mut desk = desk.clone();
        let mut frames = prefix.clone();
        let mut reply = None;
        for tick in fork..=end {
            for report in scenario
                .common
                .iter()
                .chain(reply.iter())
                .filter(|r| r.received_tick == tick)
            {
                desk.receive(report);
            }
            let read_reply = desk.advance(tick, config.read_interval) == Some("R5");
            let action = if tick == fork && review {
                Some(("baseline", "request_review", None))
            } else if tick == fork {
                let actor = if config.cited_ids.is_some() {
                    "human"
                } else {
                    "baseline"
                };
                Some((actor, "conclude", config.cited_ids.as_deref()))
            } else if review && read_reply {
                Some(("baseline", "conclude", None))
            } else {
                None
            };
            frames.push(desk.frame(tick, action)?);
            // Schedule the branch-only response after request validation.
            if tick == fork && review {
                reply =
                    Some(Statement::Clarification.report(tick + 1, tick + scenario.reply_delay));
            }
        }
        Ok(LabRun {
            frames,
            metrics: desk.metrics,
        })
    };
    Ok(LabArchive {
        kind: "c5isr-evidence-lab".into(),
        schema_version: 1,
        config: config.clone(),
        fork_tick: fork,
        end_tick: end,
        immediate: branch(false)?,
        review: branch(true)?,
    })
}

/// The same seed and cadence are paired within every row; subsequent rows use
/// consecutive seeds. No measurements from other pairs influence either policy.
pub fn run_batch(config: &LabConfig, count: u32) -> Result<Vec<BatchRow>, String> {
    if !(1..=MAX_BATCH).contains(&count) || config.seed.checked_add(count - 1).is_none() {
        return Err("批量种子数应为 1 至 32，且末个种子不能超过 u32 上限。".into());
    }
    if config.cited_ids.is_some() {
        return Err("批量试验按规则选取逐种子可读依据，请清除单次试验的自选引用。".into());
    }
    (0..count)
        .map(|offset| {
            let seed = config.seed + offset;
            let run = run_lab(&LabConfig {
                seed,
                ..config.clone()
            })
            .map_err(|why| format!("种子 {seed}：{why}"))?;
            Ok(BatchRow {
                seed,
                immediate: run.immediate.metrics,
                review: run.review.metrics,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests;
