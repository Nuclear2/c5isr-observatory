# C5ISR Observatory — contributor instructions

Read `README.md`, `docs/architecture.md`, `contracts/state.ts` and the relevant module before editing.

## Project scope

This is a local, synthetic information-flow research simulator with manual review and explicitly enabled continuous AI information modes. Real equipment names/types are display labels only. Coordinates, motion, latency, confidence and outcomes are synthetic. J-36/J-50/095 are user-designated conceptual labels, not verified service/capability claims. Keep model decisions limited to information review, observation requests, link recovery and hold. Do not introduce real weapon performance, targeting, attack planning or weapon allocation.

## Ownership for parallel work

- `crates/sim-core/`: deterministic domain state and transitions; no HTTP, I/O, wall-clock calls, model SDKs or UI dependencies.
- `crates/server/`: local HTTP/SSE, scheduling, validated commands, model task lifecycle and experiment export.
- `web/`: React UI; only reads snapshots and submits explicit commands. Never invent connected/live data.
- `scripts/codex-bridge.mjs`: official local Codex CLI only; never read/copy authentication files or extract tokens. The server may schedule calls only after explicit user activation of AI information mode, at a minimum 60-second wall-clock interval. Never call live models from tests or on default startup/manual ticks.
- `contracts/`: shared DTO/schema contracts. Coordinate with all consumers before changing them.
- `docs/`: architecture, sources and decisions. Update the affected document with behavior changes.

Assign disjoint files before delegating. Shared directory edits are immediately visible. Do not overwrite another agent's work. Use dedicated Git worktrees after a repository is initialized if parallel branches are needed; each server must use a different `C5ISR_PORT`.

## Invariants

1. Only approved proposals may execute; duplicate/stale/invalid actions must fail.
2. Model suggestions never directly mutate state. Validate action, subject and evidence references.
3. Replay uses recorded snapshots/outputs; it does not request another model response.
4. Seed + same ordered domain inputs gives identical numeric evolution. Simulation ticks are not real seconds.
5. API errors and model failures stay visible; do not silently label baseline output as model output.
6. Keep localhost binding, bounded payloads, process timeouts, and provider credentials outside browser code.
7. Hidden synthetic contacts must never appear in public snapshots, events, history or observations before report reception. Visible coordinates are last received observations; expiration means archival, not destruction.
8. AI mode auto-approves only newly returned, validated Codex information tasks. Stop pauses the clock, invalidates in-flight output and cancels its owned process tree; failures stop the mode without automatic retries or a baseline masquerading as AI. Model context stays limited to anonymized own-network information.

## Checks

PowerShell: `. .\scripts\rust-env.ps1`, then `cargo fmt --all -- --check` and `cargo test --workspace`.
Frontend: `pnpm build`; motion: `node --test web/motion.test.mjs`. Bridge: `pnpm test:bridge`. HTTP acceptance: `node --test tests/http.test.mjs` (requires built Rust server and frontend).
Run live smoke tests only deliberately and with a bounded stop: they consume the user's Codex allowance. The user's 2026-10-22 request authorizes the UI's continuous AI information mode until stopped; it does not authorize tests/CI to call online models or background activation on startup.

Do not commit `.tools`, `target`, `runtime`, credentials or generated logs. Keep `Cargo.lock` and `pnpm-lock.yaml` for reproducibility.
