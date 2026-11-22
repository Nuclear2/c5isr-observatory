import type { BranchFrame, StrategyStudy } from '../contracts/strategy';

export function verificationState(branch: BranchFrame, terminal: boolean) {
  const last = branch.decisions.at(-1);
  if (last?.action === 'conclude') return 'concluded';
  if (last?.action === 'insufficient') return 'insufficient';
  if (branch.reports.some(r => r.kind === 'verification' && r.read_tick === null)) return 'unread';
  return terminal ? 'not_received' : 'waiting';
}

export function strategyAtCursor(study: StrategyStudy, index: number, reveal: boolean) {
  const frame = study.frames[index];
  const terminal = frame.tick === study.end_tick;
  return {
    frame,
    terminal,
    links: study.link_events.filter(event => event.tick <= frame.tick),
    settlement: terminal && reveal ? study.settlement : null,
  };
}
