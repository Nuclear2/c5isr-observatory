/** Recorded collector-health experiment. All times are simulation ticks. */
export type LabBranch = 'immediate' | 'review';
export type LabClaim = 'normal' | 'interrupted';
export interface LabConfig {
  seed: number;
  read_interval: number;
  fork_tick?: number | null;
  cited_ids?: string[] | null;
}
export interface LabReport {
  id: string;
  source: string;
  root_id: string;
  kind: 'direct' | 'relay' | 'self_check' | 'correction' | 'clarification';
  claim: LabClaim;
  period_start: number;
  period_end: number;
  issued_tick: number;
  received_tick: number;
  read_tick: number | null;
  derived_from: string | null;
  revises: string | null;
  note: string;
}
export interface LabDecision {
  tick: number;
  actor: 'baseline' | 'human';
  action: 'conclude' | 'request_review';
  claim: LabClaim | 'undetermined';
  evidence_ids: string[];
  read_ids: string[];
  independent_roots: string[];
}
export interface LabMetrics {
  conflict_ticks: number;
  corrected_approvals: number;
  review_requests: number;
}
export interface LabFrame {
  tick: number;
  reports: LabReport[];
  queue_ids: string[];
  active_ids: string[];
  independent_roots: string[];
  conflict: boolean;
  decisions: LabDecision[];
  metrics: LabMetrics;
}
export interface LabRun {
  frames: LabFrame[];
  metrics: LabMetrics;
}
export interface BatchRow {
  seed: number;
  immediate: LabMetrics;
  review: LabMetrics;
}
export interface RecordedAdvice {
  provider: 'codex';
  branch: LabBranch;
  tick: number;
  read_ids: string[];
  action: 'hold' | 'request_review' | 'conclude';
  evidence_ids: string[];
  source_count: number;
  verified_source_count: number;
  reason: string;
  uncertainties: string[];
}
export interface LabArchive {
  kind: 'c5isr-evidence-lab';
  schema_version: 1;
  config: LabConfig;
  fork_tick: number;
  end_tick: number;
  immediate: LabRun;
  review: LabRun;
  advice?: RecordedAdvice[];
  batch?: BatchRow[];
}
