import type { DecisionEvent } from '../contracts/state';
import { isReportEvent } from './decisions.ts';

type Report = NonNullable<DecisionEvent['desk_report']>;
type Judgment = NonNullable<DecisionEvent['desk_judgment']>;

export interface DeskEntry {
  report: Report;
  readTick: number | null;
  readSeq: number | null;
}

export interface FrozenJudgment {
  tick: number;
  seq: number;
  judgment: Judgment;
  read: DeskEntry[];
}

export interface ReviewCase {
  id: string;
  entries: DeskEntry[];
  judgments: FrozenJudgment[];
  lastReadSeq: number;
  transport?: DecisionEvent;
}

/** The caller supplies eventsAtFrame in sequence order, including any selected
 * same-tick cutoff. A receipt adds an envelope; only a reading adds a claim. */
export function reviewCases(events: readonly DecisionEvent[]): ReviewCase[] {
  const cases = new Map<string, ReviewCase>();
  const transports = new Map<string, DecisionEvent>();
  for (const event of events) {
    const id = event.proposal_id;
    if (isReportEvent(event)) {
      transports.set(id, event);
      continue;
    }
    let item = cases.get(id);
    if (event.kind === 'desk_received' && event.desk_report) {
      if (!item) {
        item = { id, entries: [], judgments: [], lastReadSeq: 0 };
        cases.set(id, item);
      }
      item.entries.push({ report: { ...event.desk_report, claim: null }, readTick: null, readSeq: null });
    } else if (item && event.kind === 'desk_read' && event.desk_report) {
      const report = event.desk_report;
      const index = item.entries.findIndex(entry => entry.report.id === report.id);
      if (index < 0) continue;
      item.entries[index] = { report, readTick: event.tick, readSeq: event.seq };
      item.lastReadSeq = event.seq;
    } else if (item && event.kind === 'desk_judged' && event.desk_judgment) {
      const judgment = event.desk_judgment;
      // Keep the reading as of the decision. The desk can still receive and
      // read the supplementary report after someone has cited the relay.
      const read = item.entries.filter(entry => entry.readSeq !== null && judgment.read_ids.includes(entry.report.id));
      item.judgments.push({ seq: event.seq, tick: event.tick, judgment, read });
    }
  }
  for (const item of cases.values()) item.transport = transports.get(item.id);
  return [...cases.values()].reverse();
}
