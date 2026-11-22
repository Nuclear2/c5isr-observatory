export type ReceiptDelivery = 'delivered' | 'lost';
export type FieldStatus = 'sampled_buffered' | 'not_sampled';
export interface StatusReceipt {
  id: string;
  case_id: string;
  source_id: string;
  status: FieldStatus;
  as_of_tick: number;
  sampled_tick: number | null;
  sent_tick: number;
  received_tick: number;
}
export interface CenterView {
  link_enabled: boolean;
  request: { id: string; approved_tick: number; approval_seq: number } | null;
  expected_tick: number | null;
  receipts: StatusReceipt[];
  knowledge: { status: FieldStatus; as_of_tick: number; known_tick: number; receipt_id: string } | null;
}
export interface ReceiptFrame {
  tick: number;
  buffered: CenterView;
  not_sampled: CenterView;
}
export interface FieldAudit {
  status: FieldStatus;
  as_of_tick: number;
  sampled_tick: number | null;
  sent_tick: number;
  received_tick: number | null;
  receipt_id: string;
}
export interface ReceiptStudy {
  kind: 'c5isr-receipt-study';
  schema_version: 1;
  case_id: string;
  source_id: string;
  approval_seq: number;
  start_tick: number;
  end_tick: number;
  delivery: ReceiptDelivery;
  frames: ReceiptFrame[];
  field_audit: { buffered: FieldAudit; not_sampled: FieldAudit };
}
