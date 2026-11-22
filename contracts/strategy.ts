export type Delivery = 'normal' | 'delayed' | 'lost';
export type Material = 'complete' | 'copy' | 'partial';
export type Finding = 'continuous' | 'gap';
export type UnresolvedReason = 'not_received' | 'same_source' | 'partial_coverage';
// Slot numbers start at one. A covered slot with no individual reading is null.
export interface SlotObservation { slot: number; present: boolean | null }
export interface StudyLink {
  tick: number;
  enabled: boolean;
  origin: 'recorded' | 'scenario';
  seq: number | null;
}
export interface StudyReport {
  id: string;
  kind: 'relay' | 'supplement' | 'verification';
  source_id: string;
  root_id: string | null;
  root_sampled_tick: number;
  sampled_tick: number;
  received_tick: number;
  read_tick: number | null;
  claim: Finding | null;
  coverage?: SlotObservation[];
}
export interface StudyDecision {
  tick: number;
  action: 'conclude' | 'request_verification' | 'insufficient';
  finding: Finding | null;
  read_ids: string[];
  evidence_ids: string[];
}
export interface BranchFrame { reports: StudyReport[]; decisions: StudyDecision[] }
export interface StudyFrame { tick: number; immediate: BranchFrame; verify: BranchFrame }
export interface FieldRecord {
  id: string;
  source_id: string;
  sampled_tick: number;
  expected_samples: number;
  recorded_samples: number;
  finding: Finding;
  slots?: boolean[];
}
export interface StrategyScore {
  wrong: 0 | 1;
  unresolved: 0 | 1;
  wait_ticks: number;
  verification_requests: number;
  decision_tick: number | null;
  unresolved_reason?: UnresolvedReason | null;
}
export type Score = StrategyScore;
interface StudyRecord {
  kind: 'c5isr-strategy-study';
  case_id: string;
  source_id: string;
  sampled_tick: number;
  fork_tick: number;
  fork_seq: number;
  end_tick: number;
  delivery: Delivery;
  link_events: StudyLink[];
  frames: StudyFrame[];
  settlement: { field_record: FieldRecord; immediate: StrategyScore; verify: StrategyScore };
}
export type StrategyStudy = StudyRecord & (
  | { schema_version: 1; material?: never }
  | { schema_version: 2; material: Material }
);
