export type Side = 'blue' | 'red';
export type Action = 'review_data' | 'restore_link' | 'request_observation' | 'hold';
export interface Unit {
  id: string; name: string; model_label: string; type_label: string;
  affiliation: 'PLA' | 'US' | 'TW' | 'JP' | 'KR'; side: Side;
  domain: 'air' | 'surface' | 'subsurface' | 'ground' | 'space';
  role: string; x: number; y: number; readiness: number;
  connection: 'online' | 'degraded' | 'offline'; conceptual: boolean;
  contact?: { first_seen_tick: number; last_seen_tick: number; expires_tick: number };
}
export interface Link { id: string; from: string; to: string; quality: number; latency_ticks: number; enabled: boolean; }
export type LinkState = Pick<Link, 'enabled' | 'quality' | 'latency_ticks'>;
export interface LinkChange {
  seq: number; link_id: string; cause: 'link_loss' | 'recover' | 'restore_link';
  before: LinkState; after: LinkState;
}
export interface Observation { id: string; unit_id: string; source_id: string; observed_tick: number; received_tick: number; confidence: number; note: string; }
export interface Proposal {
  id: string; title: string; rationale: string; action: Action; subject_id: string;
  evidence_ids: string[]; uncertainties: string[]; expected_effect: string;
  status: 'pending' | 'approved' | 'rejected' | 'executing' | 'completed' | 'stale';
  created_tick: number; completed_tick: number | null; source: 'baseline' | 'codex'; outcome: string | null;
}
export interface SimEvent { id: string; tick: number; kind: string; message: string; related_id: string | null; }
export interface Metrics { delivered: number; dropped: number; pending_messages: number; avg_latency_ticks: number; freshness: number; completed_tasks: number; }
export interface Perception { cycle_ticks: number; next_scan_tick: number; active_contacts: number; total_discovered: number; total_archived: number; }
// One immutable edition in a source's supplementary-report series.
// Receipt ticks are written only after the respective inbox has received the copy.
export interface ReportVersion {
  source_id: string;
  version: number;
  report_id: string;
  sampled_tick: number;
  proposal_id: string | null;
  field_received_tick: number | null;
  center_received_tick: number | null;
}
// The desk tracks synthetic collector continuity for one supplementary request.
// A receipt carries the envelope only. The read event records the claim.
export interface DeskReport {
  id: string;
  source_id: string;
  kind: 'relay' | 'supplement';
  root_id: string;
  root_sampled_tick: number;
  sampled_tick: number;
  received_tick: number;
  claim: 'continuous' | 'gap' | null;
}
export interface DeskJudgment {
  actor: 'rule' | 'human';
  finding: 'continuous' | 'gap' | 'conflict';
  read_ids: string[];
  evidence_ids: string[];
}
export interface DecisionEvent {
  seq: number;
  tick: number;
  proposal_id: string;
  kind: 'created' | 'approved' | 'rejected' | 'executing' | 'completed' | 'stale'
    | 'buffered' | 'sent' | 'received' | 'dropped' | 'expired'
    | 'desk_received' | 'desk_read' | 'desk_judged';
  actor?: 'human' | 'ai' | null;
  proposal?: Proposal | null;
  evidence?: Observation[] | null;
  report_id?: string | null;
  sampled_tick?: number | null;
  note?: string | null;
  desk_report?: DeskReport | null;
  /** A locally issued request started this sampling deadline (new relay receipts only). */
  desk_expectation_seq?: number | null;
  desk_judgment?: DeskJudgment | null;
}
// Older exports predate decision recording and have no sequence cutoff.
export interface Frame {
  tick: number; units: Unit[]; links: Link[]; metrics: Metrics; perception: Perception;
  decision_seq?: number;
  // Ordered with the decision log; absent in archives predating per-transition recording.
  link_changes?: LinkChange[];
}
export interface ModelStatus { provider: string; available: boolean; busy: boolean; last_error: string | null; last_run_tick: number | null; detail: string; }
export interface AutomationStatus {
  mode: 'manual' | 'ai'; phase: 'idle' | 'waiting' | 'analyzing' | 'executing' | 'error';
  interval_seconds: number; next_run_in_seconds: number | null;
  cycles_completed: number; auto_approved: number; last_error: string | null;
}
export interface Snapshot {
  schema_version: number; run_id: string; seed: number; tick: number; running: boolean; speed: number;
  units: Unit[]; links: Link[]; observations: Observation[]; proposals: Proposal[]; events: SimEvent[];
  metrics: Metrics; history: Frame[]; model: ModelStatus; perception: Perception; automation: AutomationStatus;
  decision_log?: DecisionEvent[];
  desk_review_version?: 1;
  // Absent from exports made before per-recipient receipt recording.
  report_versions?: ReportVersion[];
}
