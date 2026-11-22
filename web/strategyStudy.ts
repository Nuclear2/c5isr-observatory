import type { StrategyStudy } from '../contracts/strategy';

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
