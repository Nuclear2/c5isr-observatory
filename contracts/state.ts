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
export interface Frame { tick: number; units: Unit[]; links: Link[]; metrics: Metrics; perception: Perception; }
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
}
