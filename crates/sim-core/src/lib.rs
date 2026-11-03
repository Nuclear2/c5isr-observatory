//! Deterministic, synthetic information-flow simulation.
//!
//! Platform names are display labels only. Coordinates, link behavior, confidence,
//! and availability are invented and carry no real-world performance meaning.
//! The engine supports four information-management actions; all proposal actions
//! require an explicit review before execution. It contains no engagement model.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};

const COMMAND: &str = "command";
const MAX_HISTORY: usize = 360;
const MAX_EVENTS: usize = 300;
const MAX_OBSERVATIONS: usize = 100;
const MAX_PROPOSALS: usize = 40;
const EVIDENCE_MAX_AGE: u64 = 60;
const PROPOSAL_MAX_AGE: u64 = 60;
const CONTACT_TTL: u64 = 48;
const MAX_HIDDEN_OBJECTS: usize = 8;
const MAX_ACTIVE_CONTACTS: usize = 12;
const MAX_CONTACT_TOMBSTONES: usize = 64;
const HIDDEN_BIRTH_INTERVAL: u64 = 12;
static INSTANCE: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Contact {
    /// Sampling tick of the first report received for this contact.
    pub first_seen_tick: u64,
    /// Sampling tick of the latest accepted report, never hidden world time.
    pub last_seen_tick: u64,
    pub expires_tick: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Unit {
    pub id: String,
    pub name: String,
    pub model_label: String,
    pub type_label: String,
    pub affiliation: String,
    pub side: String,
    pub domain: String,
    pub role: String,
    pub x: f64,
    pub y: f64,
    pub readiness: f64,
    pub connection: String,
    pub conceptual: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contact: Option<Contact>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Link {
    pub id: String,
    pub from: String,
    pub to: String,
    pub quality: f64,
    pub latency_ticks: u64,
    pub enabled: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Observation {
    pub id: String,
    pub unit_id: String,
    pub source_id: String,
    pub observed_tick: u64,
    pub received_tick: u64,
    pub confidence: f64,
    pub note: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Proposal {
    pub id: String,
    pub title: String,
    pub rationale: String,
    pub action: String,
    pub subject_id: String,
    pub evidence_ids: Vec<String>,
    pub uncertainties: Vec<String>,
    pub expected_effect: String,
    pub status: String,
    pub created_tick: u64,
    pub completed_tick: Option<u64>,
    pub source: String,
    pub outcome: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModelProposal {
    pub title: String,
    pub rationale: String,
    pub action: String,
    pub subject_id: String,
    pub evidence_ids: Vec<String>,
    pub uncertainties: Vec<String>,
    pub expected_effect: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SimEvent {
    pub id: String,
    pub tick: u64,
    pub kind: String,
    pub message: String,
    pub related_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Metrics {
    pub delivered: u64,
    pub dropped: u64,
    pub pending_messages: usize,
    pub avg_latency_ticks: f64,
    pub freshness: f64,
    pub completed_tasks: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Perception {
    pub cycle_ticks: u32,
    pub next_scan_tick: u64,
    pub active_contacts: usize,
    pub total_discovered: u64,
    pub total_archived: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Frame {
    pub tick: u64,
    pub units: Vec<Unit>,
    pub links: Vec<Link>,
    pub metrics: Metrics,
    pub perception: Perception,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub schema_version: u32,
    pub run_id: String,
    pub seed: u64,
    pub tick: u64,
    pub running: bool,
    pub speed: u32,
    pub units: Vec<Unit>,
    pub links: Vec<Link>,
    pub observations: Vec<Observation>,
    pub proposals: Vec<Proposal>,
    pub events: Vec<SimEvent>,
    pub metrics: Metrics,
    pub perception: Perception,
    pub history: Vec<Frame>,
}

#[derive(Clone, Debug)]
struct QueuedMessage {
    observation: Observation,
    due: u64,
    /// Captured observation coordinates/labels, not a live reference to hidden truth.
    contact_report: Option<Unit>,
}

/// Private scenario state. This type is deliberately not serializable.
#[derive(Clone, Debug, PartialEq)]
struct HiddenObject {
    symbol: Unit,
    leaves_tick: u64,
    dx: f64,
    dy: f64,
}

#[derive(Clone, Debug)]
pub struct Engine {
    state: Snapshot,
    rng: u64,
    world_rng: u64,
    event_seq: u64,
    observation_seq: u64,
    proposal_seq: u64,
    latency_total: u64,
    noisy_until: u64,
    queue: Vec<QueuedMessage>,
    executions: Vec<(String, u64)>,
    hidden_objects: Vec<HiddenObject>,
    hidden_seq: u64,
    next_birth_tick: u64,
    archived_contact_ids: Vec<String>,
}

impl Engine {
    pub fn new(seed: u64) -> Self {
        let units = initial_units();
        let links = units
            .iter()
            .filter(|u| u.side == "blue" && u.id != COMMAND)
            .map(|u| Link {
                id: format!("link-{}", u.id),
                from: u.id.clone(),
                to: COMMAND.into(),
                quality: if u.id == "pla-055" { 0.42 } else { 0.93 },
                latency_ticks: if u.id == "pla-055" { 5 } else { 2 },
                enabled: true,
            })
            .collect();
        let mut engine = Self {
            state: Snapshot {
                schema_version: 1,
                run_id: format!(
                    "synth-{seed:016x}-{}",
                    INSTANCE.fetch_add(1, Ordering::Relaxed)
                ),
                seed,
                tick: 0,
                running: false,
                speed: 1,
                units,
                links,
                observations: Vec::new(),
                proposals: Vec::new(),
                events: Vec::new(),
                metrics: Metrics {
                    delivered: 0,
                    dropped: 0,
                    pending_messages: 0,
                    avg_latency_ticks: 0.0,
                    freshness: 1.0,
                    completed_tasks: 0,
                },
                perception: Perception {
                    cycle_ticks: 8,
                    next_scan_tick: 8,
                    active_contacts: 0,
                    total_discovered: 0,
                    total_archived: 0,
                },
                history: Vec::new(),
            },
            rng: seed ^ 0xa076_1d64_78bd_642f,
            world_rng: seed ^ 0xe703_7ed1_a0b4_28db,
            event_seq: 0,
            observation_seq: 0,
            proposal_seq: 0,
            latency_total: 0,
            noisy_until: 0,
            queue: Vec::new(),
            executions: Vec::new(),
            hidden_objects: Vec::new(),
            hidden_seq: 0,
            next_birth_tick: 3,
            archived_contact_ids: Vec::new(),
        };
        for index in 1..engine.state.units.len() {
            let confidence = 0.64 + engine.random() * 0.25;
            let unit = &engine.state.units[index];
            let source = if unit.side == "blue" {
                unit.id.clone()
            } else {
                "pla-kj700".into()
            };
            let observation = engine.make_observation(
                index,
                source,
                confidence,
                "初始合成信息样本；不代表实际侦察能力",
            );
            engine.receive(observation);
        }
        engine.event(
            "scenario",
            "我方信息视角已加载；未知接触仅在合成扫描报告到达后显示，所有参数为虚构值",
            None,
        );
        engine.generate_baseline();
        engine.refresh_metrics();
        engine.record_frame();
        engine
    }

    pub fn snapshot(&self) -> Snapshot {
        self.state.clone()
    }

    /// Advance exactly one tick. A scheduler owns wall time, running, and speed.
    pub fn step(&mut self) {
        self.state.tick += 1;
        self.expire_proposals();
        self.process_actions();
        self.move_symbols();
        self.advance_hidden_world();
        for _ in 0..2 {
            self.generate_message();
        }
        if self.state.tick >= self.state.perception.next_scan_tick {
            self.scan_contacts();
            self.state.perception.next_scan_tick =
                self.state.tick + u64::from(self.state.perception.cycle_ticks);
        }
        self.deliver_due();
        self.expire_contacts();
        if self.state.tick % 12 == 0 {
            self.generate_baseline();
        }
        self.refresh_metrics();
        self.record_frame();
    }

    pub fn set_running(&mut self, running: bool) {
        if self.state.running != running {
            self.state.running = running;
            self.event(
                "control",
                if running {
                    "仿真时钟已启动"
                } else {
                    "仿真时钟已暂停"
                },
                None,
            );
        }
    }

    pub fn set_speed(&mut self, speed: u32) -> Result<(), String> {
        if ![1, 2, 4, 8].contains(&speed) {
            return Err("速度只能为 1、2、4、8".into());
        }
        self.state.speed = speed;
        self.event("control", &format!("仿真时钟速度设为 {speed}×"), None);
        Ok(())
    }

    /// Configure an information sampling schedule; this is not an OODA model.
    pub fn set_observation_cycle(&mut self, cycle_ticks: u32) -> Result<(), String> {
        if ![4, 8, 16, 32].contains(&cycle_ticks) {
            return Err("感知循环只能为 4、8、16、32 tick".into());
        }
        self.state.perception.cycle_ticks = cycle_ticks;
        self.state.perception.next_scan_tick = self.state.tick + u64::from(cycle_ticks);
        self.event(
            "control",
            &format!(
                "合成感知循环设为 {cycle_ticks} tick；下次扫描 tick {}",
                self.state.perception.next_scan_tick
            ),
            None,
        );
        self.replace_current_frame();
        Ok(())
    }

    /// User-controlled experimental disturbances, not executable model actions.
    pub fn inject(&mut self, kind: &str) -> Result<(), String> {
        match kind {
            "link_loss" => {
                for link in &mut self.state.links {
                    if link.from == "pla-kj700" {
                        link.enabled = false;
                        link.quality = 0.08;
                        link.latency_ticks = 9;
                    } else if link.from == "pla-055" {
                        link.quality = 0.23;
                        link.latency_ticks = 7;
                    }
                }
                self.event(
                    "injection",
                    "实验注入：合成链路中断与延迟上升",
                    Some("link-pla-kj700"),
                );
            }
            "sensor_noise" => {
                self.noisy_until = self.state.tick + 24;
                self.event(
                    "injection",
                    "实验注入：未来 24 tick 的合成观察置信度降低",
                    None,
                );
            }
            "recover" => {
                for link in &mut self.state.links {
                    link.enabled = true;
                    link.quality = 0.94;
                    link.latency_ticks = 2;
                }
                self.noisy_until = 0;
                self.event(
                    "injection",
                    "实验恢复：合成链路和观察噪声恢复基准状态",
                    None,
                );
            }
            _ => return Err(format!("未知实验注入类型：{kind}")),
        }
        self.refresh_metrics();
        self.replace_current_frame();
        Ok(())
    }

    pub fn review(&mut self, id: &str, approve: bool) -> Result<(), String> {
        let index = self
            .state
            .proposals
            .iter()
            .position(|p| p.id == id)
            .ok_or_else(|| "找不到建议".to_string())?;
        let proposal = &self.state.proposals[index];
        if proposal.status != "pending" {
            return Err("只有待审阅建议可以批准或拒绝".into());
        }
        if self.state.tick.saturating_sub(proposal.created_tick) > PROPOSAL_MAX_AGE {
            return Err("建议已过期，请生成新建议".into());
        }
        if approve {
            self.validate_model_proposal(&proposal.as_model())?;
        }
        self.state.proposals[index].status = if approve { "approved" } else { "rejected" }.into();
        if !approve {
            self.state.proposals[index].outcome = Some("建议已拒绝；未执行任何动作".into());
        }
        self.event(
            "review",
            if approve {
                "建议已批准；等待下一 tick 执行"
            } else {
                "建议已拒绝"
            },
            Some(id),
        );
        Ok(())
    }

    /// Validate the complete batch before mutating any state.
    pub fn add_model_proposals(&mut self, proposals: Vec<ModelProposal>) -> Result<(), String> {
        if proposals.is_empty() || proposals.len() > 4 {
            return Err("每批模型建议数量必须在 1..4 之间".into());
        }
        let active = self
            .state
            .proposals
            .iter()
            .filter(|p| is_active(&p.status))
            .count();
        if active + proposals.len() > 12 {
            return Err("待处理建议过多，请先审阅现有建议".into());
        }
        let mut batch_keys = HashSet::new();
        for proposal in &proposals {
            self.validate_model_proposal(proposal)?;
            let key = (&proposal.action, &proposal.subject_id);
            if !batch_keys.insert(key) {
                return Err("同批次不能重复提交相同动作和对象".into());
            }
            if self.state.proposals.iter().any(|p| {
                is_active(&p.status)
                    && p.action == proposal.action
                    && p.subject_id == proposal.subject_id
            }) {
                return Err(format!(
                    "已有同对象同动作的待处理建议：{}",
                    proposal.subject_id
                ));
            }
        }
        for proposal in proposals {
            self.insert_proposal(proposal, "codex");
        }
        self.trim_proposals();
        Ok(())
    }

    fn validate_model_proposal(&self, proposal: &ModelProposal) -> Result<(), String> {
        for (field, value, limit) in [
            ("title", proposal.title.as_str(), 160),
            ("rationale", proposal.rationale.as_str(), 1600),
            ("expected_effect", proposal.expected_effect.as_str(), 800),
        ] {
            if value.trim().is_empty() || value.chars().count() > limit {
                return Err(format!("{field} 不能为空且不能超过 {limit} 字符"));
            }
        }
        if proposal.uncertainties.is_empty()
            || proposal.uncertainties.len() > 8
            || proposal
                .uncertainties
                .iter()
                .any(|s| s.trim().is_empty() || s.chars().count() > 400)
        {
            return Err("uncertainties 必须包含 1..8 条有效不确定性说明".into());
        }
        if proposal.evidence_ids.is_empty() || proposal.evidence_ids.len() > 12 {
            return Err("建议必须引用 1..12 条现有观察证据".into());
        }
        let mut seen = HashSet::new();
        for id in &proposal.evidence_ids {
            if !seen.insert(id) {
                return Err("证据引用不能重复".into());
            }
            let observation = self
                .state
                .observations
                .iter()
                .find(|o| &o.id == id)
                .ok_or_else(|| format!("未知或已移出窗口的证据：{id}"))?;
            if self.state.tick.saturating_sub(observation.observed_tick) > EVIDENCE_MAX_AGE {
                return Err(format!("证据已过期：{id}"));
            }
        }
        let own_unit = self
            .state
            .units
            .iter()
            .any(|u| u.id == proposal.subject_id && u.side == "blue" && u.id != COMMAND);
        let own_link = self
            .state
            .links
            .iter()
            .any(|link| link.id == proposal.subject_id);
        match proposal.action.as_str() {
            "restore_link" if own_link => {}
            "review_data" | "request_observation" if own_unit => {}
            "hold" if proposal.subject_id == COMMAND => {}
            "restore_link" | "review_data" | "request_observation" | "hold" => {
                return Err(
                    "动作对象不合法；仅支持己方信息节点、己方链路或 command 暂缓动作".into(),
                );
            }
            _ => {
                return Err(
                    "动作不在允许列表：review_data / restore_link / request_observation / hold"
                        .into(),
                );
            }
        }
        // Evidence must concern the information object, not merely exist.
        if proposal.action != "hold" {
            let subject = if proposal.action == "restore_link" {
                &self
                    .state
                    .links
                    .iter()
                    .find(|l| l.id == proposal.subject_id)
                    .unwrap()
                    .from
            } else {
                &proposal.subject_id
            };
            let relevant = proposal.evidence_ids.iter().any(|id| {
                self.state
                    .observations
                    .iter()
                    .any(|o| &o.id == id && (&o.unit_id == subject || &o.source_id == subject))
            });
            if !relevant {
                return Err("至少一条证据必须关联动作对象或该对象的信息源".into());
            }
        }
        Ok(())
    }

    fn random(&mut self) -> f64 {
        next_random(&mut self.rng)
    }

    fn make_observation(
        &mut self,
        index: usize,
        source_id: String,
        confidence: f64,
        note: &str,
    ) -> Observation {
        self.observation_seq += 1;
        Observation {
            id: format!("obs-{:06}", self.observation_seq),
            unit_id: self.state.units[index].id.clone(),
            source_id,
            observed_tick: self.state.tick,
            received_tick: self.state.tick,
            confidence,
            note: note.into(),
        }
    }

    fn generate_message(&mut self) {
        // Periodic blue-node status traffic is independent of contact scanning.
        let source = self.state.links[self.observation_seq as usize % self.state.links.len()]
            .from
            .clone();
        let index = self
            .state
            .units
            .iter()
            .position(|u| u.id == source)
            .unwrap();
        let noisy = self.noisy_until != 0 && self.state.tick <= self.noisy_until;
        let confidence = if noisy {
            0.28 + self.random() * 0.28
        } else {
            0.68 + self.random() * 0.25
        };
        let observation = self.make_observation(
            index,
            source,
            confidence,
            if noisy {
                "合成观察受实验噪声影响；需要进一步复核"
            } else {
                "周期合成信息样本；位置与数值均为虚构"
            },
        );
        self.event("observe", "节点生成合成观察信息", Some(&observation.id));
        self.enqueue_message(observation, None);
    }

    fn enqueue_message(&mut self, mut observation: Observation, contact_report: Option<Unit>) {
        let link = self
            .state
            .links
            .iter()
            .find(|l| l.from == observation.source_id)
            .unwrap()
            .clone();
        if !link.enabled || self.random() > link.quality {
            self.state.metrics.dropped += 1;
            self.event(
                "drop",
                "合成传输丢失；该消息未进入已接收证据",
                Some(&link.id),
            );
            return;
        }
        let due = self.state.tick + link.latency_ticks + (self.random() * 3.0) as u64;
        observation.received_tick = due;
        self.queue.push(QueuedMessage {
            observation,
            due,
            contact_report,
        });
        self.event(
            "transmit",
            &format!("消息排入传输队列，预计 tick {due} 到达"),
            Some(&link.id),
        );
    }

    fn deliver_due(&mut self) {
        let mut ready = Vec::new();
        self.queue.retain(|message| {
            if message.due <= self.state.tick {
                ready.push(message.clone());
                false
            } else {
                true
            }
        });
        for message in ready {
            if let Some(report) = message.contact_report {
                self.receive_contact(message.observation, report);
            } else {
                self.receive(message.observation);
            }
        }
    }

    fn receive(&mut self, observation: Observation) {
        self.latency_total += observation
            .received_tick
            .saturating_sub(observation.observed_tick);
        self.state.metrics.delivered += 1;
        self.event(
            "fuse",
            "观察已接收，进入信息汇聚和证据窗口",
            Some(&observation.id),
        );
        self.state.observations.push(observation);
        trim_front(&mut self.state.observations, MAX_OBSERVATIONS);
    }

    fn move_symbols(&mut self) {
        // Only own positions are live. Public red contacts never follow hidden motion.
        for index in 1..self.state.units.len() {
            if self.state.units[index].side != "blue" {
                continue;
            }
            let dx = (self.random() - 0.5) * 0.44;
            let dy = (self.random() - 0.5) * 0.44;
            self.state.units[index].x = (self.state.units[index].x + dx).clamp(6.0, 94.0);
            self.state.units[index].y = (self.state.units[index].y + dy).clamp(6.0, 94.0);
        }
    }

    fn advance_hidden_world(&mut self) {
        // Independent RNG makes the synthetic environment identical across sampling schedules.
        // Births, departures, true coordinates and unobserved identities never emit events.
        self.hidden_objects
            .retain(|object| object.leaves_tick > self.state.tick);
        for object in &mut self.hidden_objects {
            object.symbol.x += object.dx;
            object.symbol.y += object.dy;
            if !(6.0..=94.0).contains(&object.symbol.x) {
                object.dx = -object.dx;
            }
            if !(6.0..=94.0).contains(&object.symbol.y) {
                object.dy = -object.dy;
            }
            object.symbol.x = object.symbol.x.clamp(6.0, 94.0);
            object.symbol.y = object.symbol.y.clamp(6.0, 94.0);
        }
        if self.state.tick < self.next_birth_tick {
            return;
        }
        self.next_birth_tick = self.state.tick + HIDDEN_BIRTH_INTERVAL;
        if self.hidden_objects.len() >= MAX_HIDDEN_OBJECTS {
            return;
        }
        self.hidden_seq += 1;
        let labels = [
            ("F-35", "战斗机符号", "US", "air"),
            ("P-8A", "巡逻机符号", "US", "air"),
            ("F-16V", "战斗机符号", "TW", "air"),
            ("Maya-class / 摩耶级", "驱逐舰符号", "JP", "surface"),
            ("Sejong-class / 世宗大王级", "驱逐舰符号", "KR", "surface"),
        ];
        let label_index = ((self.hidden_seq - 1 + self.state.seed % labels.len() as u64)
            % labels.len() as u64) as usize;
        let (model, type_label, affiliation, domain) = labels[label_index];
        let x = 54.0 + next_random(&mut self.world_rng) * 35.0;
        let y = 12.0 + next_random(&mut self.world_rng) * 76.0;
        let lifetime = 40 + (next_random(&mut self.world_rng) * 17.0) as u64;
        let dx = (0.12 + next_random(&mut self.world_rng) * 0.16)
            * if next_random(&mut self.world_rng) > 0.5 {
                1.0
            } else {
                -1.0
            };
        let dy = (0.10 + next_random(&mut self.world_rng) * 0.14)
            * if next_random(&mut self.world_rng) > 0.5 {
                1.0
            } else {
                -1.0
            };
        self.hidden_objects.push(HiddenObject {
            symbol: Unit {
                id: format!("contact-{:06}", self.hidden_seq),
                name: format!("合成接触 {:03}", self.hidden_seq),
                model_label: model.into(),
                type_label: type_label.into(),
                affiliation: affiliation.into(),
                side: "red".into(),
                domain: domain.into(),
                role: "已接收合成接触报告；位置为最近观测值".into(),
                x,
                y,
                readiness: 0.0,
                connection: "online".into(),
                conceptual: false,
                contact: None,
            },
            leaves_tick: self.state.tick + lifetime,
            dx,
            dy,
        });
    }

    fn scan_contacts(&mut self) {
        self.event(
            "perception_scan",
            "执行合成感知循环；扫描报告须经过链路接收后才能更新态势",
            None,
        );
        let objects = self.hidden_objects.clone();
        let noisy = self.noisy_until != 0 && self.state.tick <= self.noisy_until;
        for (index, object) in objects.into_iter().enumerate() {
            if self.archived_contact_ids.contains(&object.symbol.id) {
                continue;
            }
            // No geometry, detection ranges or equipment capability model is used.
            if self.random() > if noisy { 0.60 } else { 0.86 } {
                continue;
            }
            let source = self.state.links[(index
                + (self.state.tick / u64::from(self.state.perception.cycle_ticks)) as usize)
                % self.state.links.len()]
            .from
            .clone();
            let confidence = if noisy {
                0.30 + self.random() * 0.25
            } else {
                0.66 + self.random() * 0.26
            };
            let mut report = object.symbol;
            let error_scale = if noisy { 1.5 } else { 0.35 };
            report.x = (report.x + (self.random() - 0.5) * error_scale).clamp(0.0, 100.0);
            report.y = (report.y + (self.random() - 0.5) * error_scale).clamp(0.0, 100.0);
            report.readiness = confidence;
            self.observation_seq += 1;
            let observation = Observation {
                id: format!("obs-{:06}", self.observation_seq),
                unit_id: report.id.clone(),
                source_id: source,
                observed_tick: self.state.tick,
                received_tick: self.state.tick,
                confidence,
                note: if noisy {
                    "合成接触采样；噪声影响位置与置信度，标签不代表真实识别能力"
                } else {
                    "合成接触采样；报告位置为采样值，标签不代表真实识别能力"
                }
                .into(),
            };
            // Until receipt only generic transport information is public.
            self.enqueue_message(observation, Some(report));
        }
    }

    fn receive_contact(&mut self, observation: Observation, mut report: Unit) {
        if self.archived_contact_ids.contains(&report.id)
            || self.state.tick >= observation.observed_tick + CONTACT_TTL
        {
            self.event(
                "stale_report",
                "过期合成接触报告未用于更新当前态势",
                Some(&observation.id),
            );
            return;
        }
        let existing = self
            .state
            .units
            .iter()
            .position(|unit| unit.id == report.id);
        let first_seen = existing
            .and_then(|index| self.state.units[index].contact.as_ref())
            .map(|contact| contact.first_seen_tick)
            .unwrap_or(observation.observed_tick);
        let latest_seen = existing
            .and_then(|index| self.state.units[index].contact.as_ref())
            .map(|contact| contact.last_seen_tick);
        let report_is_newer = latest_seen.is_none_or(|last| observation.observed_tick > last);
        let contact_id = report.id.clone();
        let evidence_id = observation.id.clone();
        let source_id = observation.source_id.clone();
        report.contact = Some(Contact {
            first_seen_tick: first_seen,
            last_seen_tick: observation.observed_tick,
            expires_tick: observation.observed_tick + CONTACT_TTL,
        });
        if report_is_newer {
            if let Some(index) = existing {
                self.state.units[index] = report;
                self.event(
                    "contact_refreshed",
                    "已接收新合成报告，更新接触的最近观测位置与时效",
                    Some(&contact_id),
                );
            } else {
                if self.state.units.iter().filter(|u| u.side == "red").count()
                    >= MAX_ACTIVE_CONTACTS
                {
                    let oldest = self
                        .state
                        .units
                        .iter()
                        .filter(|u| u.side == "red")
                        .min_by_key(|u| u.contact.as_ref().unwrap().last_seen_tick)
                        .unwrap()
                        .id
                        .clone();
                    self.archive_contact(&oldest, "达到接触窗口容量，旧记录移出当前态势");
                }
                self.state.units.push(report);
                self.state.perception.total_discovered += 1;
                self.event(
                    "contact_discovered",
                    "首次接收合成接触报告；加入我方可见态势，位置为观测值",
                    Some(&contact_id),
                );
            }
        } else {
            self.event(
                "out_of_order",
                "较旧接触报告已接收，保留证据但不回退态势位置",
                Some(&contact_id),
            );
        }
        self.receive(observation);
        if existing.is_none() {
            self.suggest_discovery_review(&source_id, &evidence_id);
        }
    }

    fn suggest_discovery_review(&mut self, source_id: &str, evidence_id: &str) {
        if self.has_active("review_data", source_id)
            || self
                .state
                .proposals
                .iter()
                .filter(|p| is_active(&p.status))
                .count()
                >= 6
        {
            return;
        }
        self.insert_proposal(
            ModelProposal {
                title: "复核新接触的信息来源".into(),
                rationale: "首次收到合成接触报告，建议检查我方来源节点的信息一致性与不确定性。"
                    .into(),
                action: "review_data".into(),
                subject_id: source_id.into(),
                evidence_ids: vec![evidence_id.into()],
                uncertainties: vec![
                    "新接触只代表已接收的合成报告；当前未知的对象和真实位置不可见。".into(),
                ],
                expected_effect: "人工批准后复核我方来源节点的报告；不会移动、删除或处置接触。"
                    .into(),
            },
            "baseline",
        );
        self.trim_proposals();
    }

    fn expire_contacts(&mut self) {
        let expired: Vec<String> = self
            .state
            .units
            .iter()
            .filter(|unit| {
                unit.contact
                    .as_ref()
                    .is_some_and(|c| self.state.tick >= c.expires_tick)
            })
            .map(|unit| unit.id.clone())
            .collect();
        for id in expired {
            self.archive_contact(&id, "报告超过 48 tick 未获有效刷新，接触记录到期");
        }
    }

    fn archive_contact(&mut self, id: &str, reason: &str) {
        let previous_len = self.state.units.len();
        self.state
            .units
            .retain(|unit| unit.id != id || unit.side != "red");
        if self.state.units.len() == previous_len {
            return;
        }
        self.archived_contact_ids.push(id.into());
        trim_front(&mut self.archived_contact_ids, MAX_CONTACT_TOMBSTONES);
        self.state.perception.total_archived += 1;
        self.event(
            "contact_archived",
            &format!("{reason}；已归档移出当前态势，不表示对象被摧毁"),
            Some(id),
        );
    }

    fn process_actions(&mut self) {
        let now = self.state.tick;
        let due: Vec<String> = self
            .executions
            .iter()
            .filter(|(_, tick)| *tick <= now)
            .map(|(id, _)| id.clone())
            .collect();
        self.executions.retain(|(_, tick)| *tick > now);
        for id in due {
            if let Some(index) = self
                .state
                .proposals
                .iter()
                .position(|p| p.id == id && p.status == "executing")
            {
                let proposal = self.state.proposals[index].clone();
                if let Err(error) = self.validate_model_proposal(&proposal.as_model()) {
                    self.state.proposals[index].status = "stale".into();
                    self.state.proposals[index].outcome =
                        Some(format!("完成前证据校验未通过：{error}；未应用动作"));
                    self.event("stale", "执行期间证据已失效；未应用信息管理动作", Some(&id));
                    continue;
                }
                let outcome = self.apply_action(&proposal);
                self.state.proposals[index].status = "completed".into();
                self.state.proposals[index].completed_tick = Some(now);
                self.state.proposals[index].outcome = Some(outcome.clone());
                self.state.metrics.completed_tasks += 1;
                self.event("feedback", &outcome, Some(&id));
            }
        }
        let approved: Vec<usize> = self
            .state
            .proposals
            .iter()
            .enumerate()
            .filter(|(_, p)| p.status == "approved")
            .map(|(index, _)| index)
            .collect();
        for index in approved {
            let proposal = self.state.proposals[index].clone();
            // Re-check evidence at execution start so an approval never bypasses expiry.
            if let Err(error) = self.validate_model_proposal(&proposal.as_model()) {
                self.state.proposals[index].status = "stale".into();
                self.state.proposals[index].outcome = Some(format!("执行前校验未通过：{error}"));
                self.event(
                    "stale",
                    "已批准建议的证据不可用，需重新生成并审阅",
                    Some(&proposal.id),
                );
                continue;
            }
            self.state.proposals[index].status = "executing".into();
            self.executions.push((proposal.id.clone(), now + 1));
            self.event(
                "execute",
                "已批准的信息管理动作开始执行",
                Some(&proposal.id),
            );
        }
    }

    fn apply_action(&mut self, proposal: &Proposal) -> String {
        match proposal.action.as_str() {
            "restore_link" => {
                let link = self
                    .state
                    .links
                    .iter_mut()
                    .find(|l| l.id == proposal.subject_id)
                    .unwrap();
                let previous = link.quality;
                link.enabled = true;
                link.quality = 0.97;
                link.latency_ticks = 1;
                format!(
                    "反馈：{} 合成链路质量 {:.0}% → 97%，延迟预算 1 tick",
                    link.id,
                    previous * 100.0
                )
            }
            "review_data" => {
                let mut count = 0;
                for observation in &mut self.state.observations {
                    if proposal.evidence_ids.contains(&observation.id) {
                        observation.confidence = (observation.confidence + 0.12).min(0.98);
                        observation
                            .note
                            .push_str("；已执行合成一致性核对（非真实性保证）");
                        count += 1;
                    }
                }
                format!("反馈：已核对 {count} 条合成证据；模拟置信度增加，不表示现实正确率")
            }
            "request_observation" => {
                let index = self
                    .state
                    .units
                    .iter()
                    .position(|u| u.id == proposal.subject_id)
                    .unwrap();
                let mut observation = self.make_observation(
                    index,
                    proposal.subject_id.clone(),
                    0.86,
                    "经批准的信息补充样本；所有数值为合成数据",
                );
                observation.received_tick = self.state.tick + 1;
                self.queue.push(QueuedMessage {
                    observation,
                    due: self.state.tick + 1,
                    contact_report: None,
                });
                "反馈：补充合成信息样本已排队，预计下一 tick 到达".into()
            }
            "hold" => "反馈：已记录暂缓判断；未改变任何节点或链路状态".into(),
            _ => unreachable!("Only validated proposal actions enter execution"),
        }
    }

    fn expire_proposals(&mut self) {
        let mut expired = Vec::new();
        for proposal in &mut self.state.proposals {
            let unavailable_evidence = proposal.evidence_ids.iter().any(|id| {
                !self.state.observations.iter().any(|observation| {
                    &observation.id == id
                        && self.state.tick.saturating_sub(observation.observed_tick)
                            <= EVIDENCE_MAX_AGE
                })
            });
            if ["pending", "approved"].contains(&proposal.status.as_str())
                && (self.state.tick.saturating_sub(proposal.created_tick) > PROPOSAL_MAX_AGE
                    || unavailable_evidence)
            {
                proposal.status = "stale".into();
                proposal.outcome = Some("建议或证据已过期 / 移出证据窗口；未执行".into());
                expired.push(proposal.id.clone());
            }
        }
        for id in expired {
            self.event("stale", "建议或证据失效，需重新生成并审阅", Some(&id));
        }
    }

    fn generate_baseline(&mut self) {
        if self
            .state
            .proposals
            .iter()
            .filter(|p| is_active(&p.status))
            .count()
            >= 6
        {
            return;
        }
        let degraded = self
            .state
            .links
            .iter()
            .find(|link| {
                (!link.enabled || link.quality < 0.65) && !self.has_active("restore_link", &link.id)
            })
            .cloned();
        if let Some(link) = degraded {
            if let Some(evidence) = self.latest_evidence(&link.from) {
                self.insert_proposal(
                    ModelProposal {
                        title: "恢复合成信息链路".into(),
                        rationale: format!(
                            "{} 的合成传输质量为 {:.0}%，影响信息到达与新鲜度。",
                            link.id,
                            link.quality * 100.0
                        ),
                        action: "restore_link".into(),
                        subject_id: link.id,
                        evidence_ids: vec![evidence],
                        uncertainties: vec![
                            "链路恢复收益为预设演示效果，不能外推到真实装备。".into(),
                        ],
                        expected_effect:
                            "经批准后将该合成链路设为在线、质量 97%、延迟预算 1 tick。".into(),
                    },
                    "baseline",
                );
            }
        }
        let unit_id = if self.state.tick == 0 {
            "pla-kj700".to_string()
        } else {
            let own: Vec<&Unit> = self
                .state
                .units
                .iter()
                .filter(|u| u.side == "blue" && u.id != COMMAND)
                .collect();
            own[(self.state.tick as usize / 12) % own.len()].id.clone()
        };
        let action = if self.state.tick > 0 && self.state.tick % 24 == 0 {
            "request_observation"
        } else {
            "review_data"
        };
        if !self.has_active(action, &unit_id) {
            if let Some(evidence) = self.latest_evidence(&unit_id) {
                self.insert_proposal(
                    ModelProposal {
                        title: if action == "review_data" {
                            "核对合成观察证据"
                        } else {
                            "请求补充信息样本"
                        }
                        .into(),
                        rationale: "观察置信度与信息时效存在不确定性；先完善信息再作后续判断。"
                            .into(),
                        action: action.into(),
                        subject_id: unit_id,
                        evidence_ids: vec![evidence],
                        uncertainties: vec![
                            "模拟置信度不等于真实正确率；型号名称不赋予现实能力。".into(),
                        ],
                        expected_effect: if action == "review_data" {
                            "经批准后核对所引证据，记录合成置信度变化。"
                        } else {
                            "经批准后补充一个合成信息样本，并记录到达结果。"
                        }
                        .into(),
                    },
                    "baseline",
                );
            }
        }
        self.trim_proposals();
    }

    fn has_active(&self, action: &str, subject: &str) -> bool {
        self.state
            .proposals
            .iter()
            .any(|p| is_active(&p.status) && p.action == action && p.subject_id == subject)
    }

    fn latest_evidence(&self, subject: &str) -> Option<String> {
        self.state
            .observations
            .iter()
            .rev()
            .find(|o| {
                (o.unit_id == subject || o.source_id == subject)
                    && self.state.tick.saturating_sub(o.observed_tick) <= EVIDENCE_MAX_AGE
            })
            .map(|o| o.id.clone())
    }

    fn insert_proposal(&mut self, proposal: ModelProposal, source: &str) {
        self.proposal_seq += 1;
        let id = format!("proposal-{:05}", self.proposal_seq);
        self.event(
            "suggest",
            if source == "codex" {
                "模型已生成结构化建议，等待审批"
            } else {
                "规则基线已生成信息管理建议，等待审批"
            },
            Some(&id),
        );
        self.state.proposals.push(Proposal {
            id,
            title: proposal.title,
            rationale: proposal.rationale,
            action: proposal.action,
            subject_id: proposal.subject_id,
            evidence_ids: proposal.evidence_ids,
            uncertainties: proposal.uncertainties,
            expected_effect: proposal.expected_effect,
            status: "pending".into(),
            created_tick: self.state.tick,
            completed_tick: None,
            source: source.into(),
            outcome: None,
        });
    }

    fn trim_proposals(&mut self) {
        while self.state.proposals.len() > MAX_PROPOSALS {
            if let Some(index) = self
                .state
                .proposals
                .iter()
                .position(|p| !is_active(&p.status))
            {
                self.state.proposals.remove(index);
            } else {
                break;
            }
        }
    }

    fn refresh_metrics(&mut self) {
        let mut freshness = 0.0;
        for unit in &mut self.state.units {
            if unit.id == COMMAND {
                continue;
            }
            let latest = unit
                .contact
                .as_ref()
                .map(|contact| contact.last_seen_tick)
                .or_else(|| {
                    self.state
                        .observations
                        .iter()
                        .filter(|o| o.unit_id == unit.id)
                        .map(|o| o.observed_tick)
                        .max()
                });
            let age = latest
                .map(|t| self.state.tick.saturating_sub(t))
                .unwrap_or(30);
            freshness += (1.0 - age as f64 / 30.0).clamp(0.0, 1.0);
            if unit.side == "blue" {
                let link = self.state.links.iter().find(|l| l.from == unit.id).unwrap();
                unit.connection = if !link.enabled {
                    "offline"
                } else if link.quality < 0.65 {
                    "degraded"
                } else {
                    "online"
                }
                .into();
            } else {
                // Opposing symbols show information visibility, never live connectivity.
                unit.connection = if age < 8 {
                    "online"
                } else if age < 20 {
                    "degraded"
                } else {
                    "offline"
                }
                .into();
            }
        }
        self.state.metrics.freshness = freshness / (self.state.units.len() - 1) as f64;
        self.state.perception.active_contacts = self
            .state
            .units
            .iter()
            .filter(|unit| unit.side == "red")
            .count();
        self.state.metrics.pending_messages = self.queue.len();
        self.state.metrics.avg_latency_ticks = if self.state.metrics.delivered == 0 {
            0.0
        } else {
            self.latency_total as f64 / self.state.metrics.delivered as f64
        };
    }

    fn event(&mut self, kind: &str, message: &str, related_id: Option<&str>) {
        self.event_seq += 1;
        self.state.events.push(SimEvent {
            id: format!("event-{:07}", self.event_seq),
            tick: self.state.tick,
            kind: kind.into(),
            message: message.into(),
            related_id: related_id.map(str::to_string),
        });
        trim_front(&mut self.state.events, MAX_EVENTS);
    }

    fn record_frame(&mut self) {
        self.state.history.push(Frame {
            tick: self.state.tick,
            units: self.state.units.clone(),
            links: self.state.links.clone(),
            metrics: self.state.metrics.clone(),
            perception: self.state.perception.clone(),
        });
        trim_front(&mut self.state.history, MAX_HISTORY);
    }

    fn replace_current_frame(&mut self) {
        if self
            .state
            .history
            .last()
            .is_some_and(|frame| frame.tick == self.state.tick)
        {
            self.state.history.pop();
        }
        self.record_frame();
    }
}

impl Proposal {
    fn as_model(&self) -> ModelProposal {
        ModelProposal {
            title: self.title.clone(),
            rationale: self.rationale.clone(),
            action: self.action.clone(),
            subject_id: self.subject_id.clone(),
            evidence_ids: self.evidence_ids.clone(),
            uncertainties: self.uncertainties.clone(),
            expected_effect: self.expected_effect.clone(),
        }
    }
}

fn is_active(status: &str) -> bool {
    ["pending", "approved", "executing"].contains(&status)
}

fn next_random(state: &mut u64) -> f64 {
    // SplitMix64: stable across platforms, handles every u64 seed.
    *state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^= z >> 31;
    (z >> 11) as f64 / ((1_u64 << 53) as f64)
}

fn trim_front<T>(items: &mut Vec<T>, max: usize) {
    if items.len() > max {
        items.drain(..items.len() - max);
    }
}

fn initial_units() -> Vec<Unit> {
    // These are labels and fictional positions, not a real order of battle.
    let specs = [
        (
            COMMAND,
            "信息汇聚中心",
            "SYN-C2",
            "合成指挥节点",
            "PLA",
            "blue",
            "ground",
            18.0,
            48.0,
            false,
        ),
        (
            "pla-j20",
            "苍穹 01",
            "J-20 / 歼-20",
            "战斗机符号",
            "PLA",
            "blue",
            "air",
            35.0,
            29.0,
            false,
        ),
        (
            "pla-kj700",
            "概念节点 700",
            "KJ-700 / 空警-700",
            "用户指定概念预警机符号",
            "PLA",
            "blue",
            "air",
            24.0,
            37.0,
            true,
        ),
        (
            "pla-055",
            "海澜 01",
            "Type 055 / 055 型",
            "驱逐舰符号",
            "PLA",
            "blue",
            "surface",
            37.0,
            62.0,
            false,
        ),
        (
            "pla-j36",
            "概念节点 36",
            "J-36 / 歼-36",
            "用户指定概念航空符号",
            "PLA",
            "blue",
            "air",
            42.0,
            19.0,
            true,
        ),
        (
            "pla-j50",
            "概念节点 50",
            "J-50 / 歼-50",
            "用户指定概念航空符号",
            "PLA",
            "blue",
            "air",
            29.0,
            76.0,
            true,
        ),
        (
            "pla-095",
            "概念节点 095",
            "Type 095 / 095 型",
            "用户指定概念潜航符号",
            "PLA",
            "blue",
            "subsurface",
            44.0,
            82.0,
            true,
        ),
        (
            "pla-004",
            "概念节点 004",
            "Type 004 / 004 型航母",
            "用户指定概念航母符号",
            "PLA",
            "blue",
            "surface",
            44.0,
            54.0,
            true,
        ),
    ];
    specs
        .into_iter()
        .enumerate()
        .map(
            |(index, (id, name, model, kind, affiliation, side, domain, x, y, conceptual))| Unit {
                id: id.into(),
                name: name.into(),
                model_label: model.into(),
                type_label: kind.into(),
                affiliation: affiliation.into(),
                side: side.into(),
                domain: domain.into(),
                role: if id == COMMAND {
                    "合成信息汇聚 / 人工审阅"
                } else if side == "blue" {
                    "合成信息节点"
                } else {
                    "合成对照观察符号"
                }
                .into(),
                x,
                y,
                readiness: 0.72 + (index % 5) as f64 * 0.045,
                connection: "online".into(),
                conceptual,
                contact: None,
            },
        )
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn normalize(mut snapshot: Snapshot) -> Snapshot {
        snapshot.run_id.clear();
        snapshot
    }

    fn valid_hold(engine: &Engine) -> ModelProposal {
        ModelProposal {
            title: "暂缓判断".into(),
            rationale: "等待更多证据并保留审阅记录。".into(),
            action: "hold".into(),
            subject_id: COMMAND.into(),
            evidence_ids: vec![engine.state.observations.last().unwrap().id.clone()],
            uncertainties: vec!["所有数据均为合成样本。".into()],
            expected_effect: "记录暂缓，不改变节点状态。".into(),
        }
    }

    #[test]
    fn seed_reproduces_numeric_state_and_events() {
        let mut first = Engine::new(42);
        let mut second = Engine::new(42);
        assert_ne!(first.state.run_id, second.state.run_id);
        for tick in 0..100 {
            if tick == 7 {
                first.inject("sensor_noise").unwrap();
                second.inject("sensor_noise").unwrap();
            }
            if tick == 15 {
                first.inject("link_loss").unwrap();
                second.inject("link_loss").unwrap();
            }
            if tick == 33 {
                first.inject("recover").unwrap();
                second.inject("recover").unwrap();
            }
            first.step();
            second.step();
        }
        assert_eq!(normalize(first.snapshot()), normalize(second.snapshot()));
        assert_ne!(
            normalize(Engine::new(42).snapshot()),
            normalize(Engine::new(43).snapshot())
        );
    }

    #[test]
    fn no_action_completes_without_explicit_approval() {
        let mut engine = Engine::new(9);
        assert_eq!(engine.state.proposals.len(), 2);
        for _ in 0..140 {
            engine.step();
        }
        assert_eq!(engine.state.metrics.completed_tasks, 0);
        assert!(
            engine
                .state
                .proposals
                .iter()
                .all(|p| p.status == "pending" || p.status == "stale")
        );
        assert_eq!(
            engine
                .state
                .links
                .iter()
                .find(|l| l.from == "pla-055")
                .unwrap()
                .quality,
            0.42
        );
    }

    #[test]
    fn approved_restore_changes_link_and_reports_feedback() {
        let mut engine = Engine::new(7);
        let id = engine
            .state
            .proposals
            .iter()
            .find(|p| p.action == "restore_link")
            .unwrap()
            .id
            .clone();
        engine.review(&id, true).unwrap();
        assert!(engine.review(&id, true).is_err());
        assert_eq!(engine.state.metrics.completed_tasks, 0);
        engine.step();
        assert_eq!(
            engine
                .state
                .proposals
                .iter()
                .find(|p| p.id == id)
                .unwrap()
                .status,
            "executing"
        );
        engine.step();
        let link = engine
            .state
            .links
            .iter()
            .find(|l| l.from == "pla-055")
            .unwrap();
        assert_eq!(link.quality, 0.97);
        assert_eq!(link.latency_ticks, 1);
        assert_eq!(engine.state.metrics.completed_tasks, 1);
        let proposal = engine.state.proposals.iter().find(|p| p.id == id).unwrap();
        assert_eq!(proposal.status, "completed");
        assert_eq!(proposal.completed_tick, Some(2));
        assert!(proposal.outcome.is_some());
        assert!(
            engine
                .state
                .events
                .iter()
                .any(|e| e.kind == "feedback" && e.related_id.as_deref() == Some(&id))
        );
    }

    #[test]
    fn invalid_model_batch_is_atomic_and_hostile_subjects_are_rejected() {
        let mut engine = Engine::new(3);
        let valid = valid_hold(&engine);
        let mut invalid = valid.clone();
        invalid.action = "request_observation".into();
        invalid.subject_id = "us-f35".into();
        let before = engine.snapshot();
        assert!(
            engine
                .add_model_proposals(vec![valid.clone(), invalid])
                .is_err()
        );
        assert_eq!(engine.snapshot(), before);
        let mut bad_ref = valid.clone();
        bad_ref.evidence_ids = vec!["fabricated-evidence".into()];
        assert!(engine.add_model_proposals(vec![bad_ref]).is_err());
        assert_eq!(engine.snapshot(), before);
        engine.add_model_proposals(vec![valid]).unwrap();
        assert_eq!(engine.state.proposals.last().unwrap().source, "codex");
        assert_eq!(engine.state.proposals.last().unwrap().status, "pending");
    }

    #[test]
    fn stale_evidence_cannot_be_added_or_approved() {
        let mut engine = Engine::new(1);
        let old = valid_hold(&engine);
        let id = engine.state.proposals[0].id.clone();
        for _ in 0..61 {
            engine.step();
        }
        let before = engine.snapshot();
        assert!(engine.add_model_proposals(vec![old]).is_err());
        assert_eq!(engine.snapshot(), before);
        assert!(engine.review(&id, true).is_err());
        assert_eq!(
            engine
                .state
                .proposals
                .iter()
                .find(|p| p.id == id)
                .unwrap()
                .status,
            "stale"
        );
    }

    #[test]
    fn rejected_actions_do_not_execute_and_cannot_be_reviewed_twice() {
        let mut engine = Engine::new(2);
        let id = engine.state.proposals[0].id.clone();
        engine.review(&id, false).unwrap();
        assert!(engine.review(&id, true).is_err());
        for _ in 0..4 {
            engine.step();
        }
        assert_eq!(engine.state.metrics.completed_tasks, 0);
        assert_eq!(
            engine
                .state
                .proposals
                .iter()
                .find(|p| p.id == id)
                .unwrap()
                .status,
            "rejected"
        );
    }

    #[test]
    fn approved_observation_request_has_delayed_feedback_sample() {
        let mut engine = Engine::new(27);
        let mut request = valid_hold(&engine);
        request.action = "request_observation".into();
        request.subject_id = "pla-j20".into();
        request.evidence_ids = vec![engine.latest_evidence("pla-j20").unwrap()];
        engine.add_model_proposals(vec![request]).unwrap();
        let id = engine.state.proposals.last().unwrap().id.clone();
        engine.review(&id, true).unwrap();
        engine.step();
        engine.step();
        assert!(
            !engine
                .state
                .observations
                .iter()
                .any(|o| o.note.contains("经批准的信息补充样本"))
        );
        engine.step();
        let observation = engine
            .state
            .observations
            .iter()
            .find(|o| o.note.contains("经批准的信息补充样本"))
            .unwrap();
        assert_eq!(observation.unit_id, "pla-j20");
        assert_eq!(observation.observed_tick, 2);
        assert_eq!(observation.received_tick, 3);
        assert_eq!(observation.confidence, 0.86);
    }

    #[test]
    fn model_action_allowlist_cannot_be_extended_by_payload() {
        let mut engine = Engine::new(11);
        let before = engine.snapshot();
        let mut proposal = valid_hold(&engine);
        proposal.action = "custom_command".into();
        assert!(engine.add_model_proposals(vec![proposal]).is_err());
        assert_eq!(engine.snapshot(), before);
    }

    #[test]
    fn conceptual_roster_has_complete_information_routes_and_executable_information_task() {
        let mut engine = Engine::new(37);
        let snapshot = engine.snapshot();
        let ids: HashSet<&str> = snapshot.units.iter().map(|unit| unit.id.as_str()).collect();
        assert_eq!(ids.len(), snapshot.units.len());
        assert!(!ids.contains("pla-kj500"));
        for (id, label, domain) in [
            ("pla-kj700", "KJ-700 / 空警-700", "air"),
            ("pla-004", "Type 004 / 004 型航母", "surface"),
        ] {
            let unit = snapshot.units.iter().find(|unit| unit.id == id).unwrap();
            assert_eq!(unit.model_label, label);
            assert_eq!(unit.domain, domain);
            assert_eq!(unit.side, "blue");
            assert!(unit.conceptual);
            let routes: Vec<&Link> = snapshot
                .links
                .iter()
                .filter(|link| link.from == id)
                .collect();
            assert_eq!(routes.len(), 1);
            assert_eq!(routes[0].to, COMMAND);
            assert!(routes[0].enabled);
            assert!(routes[0].quality > 0.0);
            assert!(
                snapshot
                    .observations
                    .iter()
                    .any(|observation| observation.unit_id == id && observation.source_id == id)
            );
        }
        // Renaming the observation node must preserve the existing link-loss control path.
        engine.inject("link_loss").unwrap();
        assert!(
            !engine
                .state
                .links
                .iter()
                .find(|link| link.id == "link-pla-kj700")
                .unwrap()
                .enabled
        );
        let mut request = valid_hold(&engine);
        request.action = "request_observation".into();
        request.subject_id = "pla-004".into();
        request.evidence_ids = vec![engine.latest_evidence("pla-004").unwrap()];
        engine.add_model_proposals(vec![request]).unwrap();
        let proposal_id = engine.state.proposals.last().unwrap().id.clone();
        engine.review(&proposal_id, true).unwrap();
        for _ in 0..3 {
            engine.step();
        }
        assert_eq!(
            engine
                .state
                .proposals
                .iter()
                .find(|proposal| proposal.id == proposal_id)
                .unwrap()
                .status,
            "completed"
        );
        assert!(
            engine
                .state
                .observations
                .iter()
                .any(|observation| observation.unit_id == "pla-004"
                    && observation.note.contains("经批准的信息补充样本")
                    && observation.received_tick == 3)
        );
    }

    #[test]
    fn initial_and_unreceived_hidden_objects_are_absent_from_all_public_data() {
        let mut engine = Engine::new(42);
        assert_eq!(engine.state.units.len(), 8);
        assert_eq!(engine.state.perception.active_contacts, 0);
        assert_eq!(engine.state.perception.total_discovered, 0);
        assert!(engine.hidden_objects.is_empty());
        for _ in 0..8 {
            let snapshot = engine.snapshot();
            assert!(
                snapshot
                    .units
                    .iter()
                    .all(|unit| unit.side == "blue" && unit.contact.is_none())
            );
            assert!(
                snapshot
                    .history
                    .iter()
                    .all(|frame| frame.units.iter().all(|unit| unit.side == "blue"))
            );
            assert!(
                snapshot
                    .observations
                    .iter()
                    .all(|observation| observation.unit_id.starts_with("pla-"))
            );
            let serialized = serde_json::to_string(&snapshot).unwrap();
            assert!(!serialized.contains("\"side\":\"red\""));
            for hidden in &engine.hidden_objects {
                assert!(!serialized.contains(&hidden.symbol.id));
                assert!(!serialized.contains(&hidden.symbol.model_label));
            }
            engine.step();
        }
        assert!(!engine.hidden_objects.is_empty());
        assert!(engine.state.units.iter().all(|unit| unit.side == "blue"));
    }

    #[test]
    fn observation_cycle_reschedules_scans_and_updates_current_history_atomically() {
        let mut engine = Engine::new(19);
        assert_eq!(engine.state.perception.cycle_ticks, 8);
        assert_eq!(engine.state.perception.next_scan_tick, 8);
        let before = engine.snapshot();
        assert!(engine.set_observation_cycle(3).is_err());
        assert_eq!(engine.snapshot(), before);
        engine.set_observation_cycle(16).unwrap();
        for _ in 0..15 {
            engine.step();
        }
        assert!(
            !engine
                .state
                .events
                .iter()
                .any(|event| event.kind == "perception_scan")
        );
        engine.step();
        assert_eq!(engine.state.perception.next_scan_tick, 32);
        engine.set_observation_cycle(4).unwrap();
        assert_eq!(engine.state.perception.next_scan_tick, 20);
        assert_eq!(
            engine.state.history.last().unwrap().perception,
            engine.state.perception
        );
        for _ in 0..4 {
            engine.step();
        }
        let scans: Vec<u64> = engine
            .state
            .events
            .iter()
            .filter(|event| event.kind == "perception_scan")
            .map(|event| event.tick)
            .collect();
        assert_eq!(scans, vec![16, 20]);
        assert_eq!(engine.state.perception.next_scan_tick, 24);
    }

    fn first_contact_message(engine: &mut Engine) -> QueuedMessage {
        for link in &mut engine.state.links {
            link.enabled = true;
            link.quality = 1.0;
            link.latency_ticks = 3;
        }
        for _ in 0..64 {
            engine.step();
            if let Some(message) = engine
                .queue
                .iter()
                .find(|message| message.contact_report.is_some())
            {
                return message.clone();
            }
        }
        panic!("seeded fixture should produce a queued synthetic contact report");
    }

    #[test]
    fn contact_appears_on_receipt_and_position_is_sampled_not_hidden_truth() {
        let mut engine = Engine::new(17);
        let message = first_contact_message(&mut engine);
        let report = message.contact_report.unwrap();
        let id = report.id.clone();
        let before_receipt = serde_json::to_string(&engine.snapshot()).unwrap();
        assert!(!before_receipt.contains(&id));
        while engine.state.tick < message.due {
            engine.step();
        }
        let visible = engine
            .state
            .units
            .iter()
            .find(|unit| unit.id == id)
            .unwrap()
            .clone();
        assert_eq!((visible.x, visible.y), (report.x, report.y));
        let contact = visible.contact.as_ref().unwrap();
        assert_eq!(contact.first_seen_tick, message.observation.observed_tick);
        assert_eq!(contact.last_seen_tick, message.observation.observed_tick);
        assert_eq!(
            contact.expires_tick,
            message.observation.observed_tick + CONTACT_TTL
        );
        let hidden = engine
            .hidden_objects
            .iter()
            .find(|object| object.symbol.id == id)
            .unwrap();
        assert_ne!((visible.x, visible.y), (hidden.symbol.x, hidden.symbol.y));
        assert!(
            engine
                .state
                .events
                .iter()
                .any(|event| event.kind == "contact_discovered"
                    && event.related_id.as_deref() == Some(&id)
                    && event.tick == message.due)
        );
        engine.step();
        let after = engine
            .state
            .units
            .iter()
            .find(|unit| unit.id == id)
            .unwrap();
        assert_eq!((after.x, after.y), (visible.x, visible.y));
        assert_eq!(after.contact, visible.contact);
    }

    #[test]
    fn out_of_order_report_does_not_rewind_visible_contact_position_or_expiry() {
        let mut engine = Engine::new(17);
        let message = first_contact_message(&mut engine);
        let mut stale_report = message.contact_report.unwrap();
        let id = stale_report.id.clone();
        while engine.state.tick < message.due {
            engine.step();
        }
        let before = engine
            .state
            .units
            .iter()
            .find(|unit| unit.id == id)
            .unwrap()
            .clone();
        let discovered = engine.state.perception.total_discovered;
        stale_report.x = 1.0;
        stale_report.y = 2.0;
        let mut observation = message.observation;
        observation.id = "test-delayed-older-report".into();
        observation.observed_tick -= 1;
        observation.received_tick = engine.state.tick;
        engine.receive_contact(observation, stale_report);
        assert_eq!(
            engine
                .state
                .units
                .iter()
                .find(|unit| unit.id == id)
                .unwrap(),
            &before
        );
        assert_eq!(engine.state.perception.total_discovered, discovered);
        assert!(
            engine
                .state
                .events
                .iter()
                .any(|event| event.kind == "out_of_order")
        );
    }

    #[test]
    fn lost_refresh_expires_contact_and_archived_ids_do_not_reappear() {
        let mut engine = Engine::new(17);
        let message = first_contact_message(&mut engine);
        let report = message.contact_report.clone().unwrap();
        let id = report.id.clone();
        while engine.state.tick < message.due {
            engine.step();
        }
        for link in &mut engine.state.links {
            link.enabled = false;
        }
        // Already sent reports may still arrive; allow that before measuring TTL.
        for _ in 0..12 {
            engine.step();
        }
        let expires = engine
            .state
            .units
            .iter()
            .find(|unit| unit.id == id)
            .unwrap()
            .contact
            .as_ref()
            .unwrap()
            .expires_tick;
        while engine.state.tick < expires - 1 {
            engine.step();
        }
        assert!(engine.state.units.iter().any(|unit| unit.id == id));
        engine.step();
        assert!(!engine.state.units.iter().any(|unit| unit.id == id));
        assert!(engine.state.perception.total_archived >= 1);
        assert!(
            engine
                .state
                .events
                .iter()
                .any(|event| event.kind == "contact_archived"
                    && event.related_id.as_deref() == Some(&id)
                    && event.message.contains("不表示对象被摧毁"))
        );
        let discovered_before = engine.state.perception.total_discovered;
        // A delayed replay of a previously archived identity cannot resurrect it.
        let mut delayed = message.observation;
        delayed.observed_tick = engine.state.tick;
        delayed.received_tick = engine.state.tick;
        engine.receive_contact(delayed, report);
        assert!(!engine.state.units.iter().any(|unit| unit.id == id));
        assert_eq!(engine.state.perception.total_discovered, discovered_before);
    }

    #[test]
    fn hidden_world_is_seeded_and_independent_of_perception_cycle() {
        let mut fast = Engine::new(31);
        let mut slow = Engine::new(31);
        fast.set_observation_cycle(4).unwrap();
        slow.set_observation_cycle(32).unwrap();
        for _ in 0..160 {
            fast.step();
            slow.step();
            assert_eq!(fast.hidden_objects, slow.hidden_objects);
            assert_eq!(fast.world_rng, slow.world_rng);
        }
        assert_ne!(
            fast.state.perception.total_discovered,
            slow.state.perception.total_discovered
        );
        let mut repeat = Engine::new(31);
        repeat.set_observation_cycle(4).unwrap();
        for _ in 0..160 {
            repeat.step();
        }
        assert_eq!(normalize(fast.snapshot()), normalize(repeat.snapshot()));
    }

    #[test]
    fn dynamic_contacts_continue_with_unique_ids_and_bounded_state() {
        let mut engine = Engine::new(91);
        engine.set_observation_cycle(4).unwrap();
        let mut discovered_ids = HashSet::new();
        let mut archived_ids = HashSet::new();
        for _ in 0..2400 {
            engine.step();
            let red: Vec<&Unit> = engine
                .state
                .units
                .iter()
                .filter(|unit| unit.side == "red")
                .collect();
            let ids: HashSet<&str> = red.iter().map(|unit| unit.id.as_str()).collect();
            assert_eq!(ids.len(), red.len());
            for unit in &red {
                assert!(!archived_ids.contains(&unit.id));
                discovered_ids.insert(unit.id.clone());
            }
            archived_ids.extend(engine.archived_contact_ids.iter().cloned());
            assert!(engine.hidden_objects.len() <= MAX_HIDDEN_OBJECTS);
            assert!(red.len() <= MAX_ACTIVE_CONTACTS);
            assert!(engine.archived_contact_ids.len() <= MAX_CONTACT_TOMBSTONES);
            assert_eq!(engine.state.perception.active_contacts, red.len());
            assert_eq!(
                engine.state.perception.total_discovered - engine.state.perception.total_archived,
                red.len() as u64
            );
            assert!(
                engine
                    .state
                    .proposals
                    .iter()
                    .all(|proposal| !proposal.subject_id.starts_with("contact-"))
            );
        }
        assert!(discovered_ids.len() > 100);
        assert_eq!(
            engine.state.perception.total_discovered,
            discovered_ids.len() as u64
        );
        assert!(engine.state.perception.total_archived > 0);
        assert_eq!(engine.state.history.len(), MAX_HISTORY);
        assert!(engine.state.observations.len() <= MAX_OBSERVATIONS);
        assert!(engine.state.events.len() <= MAX_EVENTS);
    }

    #[test]
    fn rolling_windows_remain_bounded() {
        let mut engine = Engine::new(88);
        for _ in 0..2000 {
            engine.step();
        }
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.history.len(), MAX_HISTORY);
        assert!(snapshot.events.len() <= MAX_EVENTS);
        assert!(snapshot.observations.len() <= MAX_OBSERVATIONS);
        assert!(snapshot.proposals.len() <= MAX_PROPOSALS);
        assert_eq!(snapshot.history.last().unwrap().tick, 2000);
        assert_eq!(snapshot.history.first().unwrap().tick, 1641);
        assert!(snapshot.metrics.freshness >= 0.0 && snapshot.metrics.freshness <= 1.0);
        assert!(
            snapshot
                .units
                .iter()
                .all(|u| (0.0..=100.0).contains(&u.x) && (0.0..=100.0).contains(&u.y))
        );
    }
}
