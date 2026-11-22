export type Delivery = 'normal' | 'delayed' | 'lost';
export type Finding = 'continuous' | 'gap';
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
  root_id: string;
  root_sampled_tick: number;
  sampled_tick: number;
  received_tick: number;
  read_tick: number | null;
  claim: Finding | null;
}
export interface StudyDecision {
  tick: number;
  action: 'conclude' | 'request_verification';
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
}
export interface StrategyScore {
  wrong: 0 | 1;
  unresolved: 0 | 1;
  wait_ticks: number;
  verification_requests: number;
  decision_tick: number | null;
}
export type Score = StrategyScore;
export interface StrategyStudy {
  kind: 'c5isr-strategy-study';
  schema_version: 1;
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
