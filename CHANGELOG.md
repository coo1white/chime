# Changelog

All notable changes to Chime are noted here. Versions are small on purpose —
one capability per step, slow and steady.

## Unreleased

The handoff ledger — multi-agent, cross-platform collaboration.

- **Capability**: `handoff` is a shared, vendor-neutral channel where any agents
  (Claude, Codex, DeepSeek, Gemini, Chime, …) propose changes and review each other.
  `propose` records a structured change proposal (an agent proposes instead of
  editing code; a coding agent turns an accepted proposal into a real PR). `review`
  records a verdict (approve / request-changes / comment) about a proposal id or PR
  ref; a proposal gathers reviews from many agents and its status reflects the
  **consensus** of the whole panel. `status` shows one proposal with its panel and
  consensus; `list` shows what's open. Every entry has `from`/`to` (open agent slugs,
  or `to: all` to broadcast), so arbitrary permutations of agents collaborate and a
  new platform joins with no code change.
- **Implementation**: one `src/tools/handoff.ts` + one registry row. A JSON ledger
  at `~/.chime/handoff/ledger.json` — Chime's own data, so appending never touches
  the user's project code. Agent normalization, id allocation, single-verdict status,
  and panel `consensus` are pure functions; the ledger fails soft (junk reads empty).
- **Tests**: 18 offline tests — pure helpers (normalizeAgent, consensus), the
  propose→multi-agent-review round-trip (panel consensus advances the proposal),
  `status`, list filters, broadcast/bidirectional routing, and fail-closed paths.
- **Risk**: low — writes only under `~/.chime`; fails closed and never mutates the
  user's repos.

The doctor — a universal project health score.

- **Capability**: `project_doctor` diagnoses a whole project and reports a 0–100
  score with an A–F grade and prioritized, actionable findings. It internalizes the
  core idea behind [react.doctor](https://react.doctor) — one command → a health
  score with fixes — and makes it language-agnostic and strictly read-only. It
  auto-detects the toolchain (Node, Rust, Python, Go, Ruby) and runs non-mutating
  probes: git hygiene (repo? clean? in sync? stale?), dependency pinning (lockfile?),
  housekeeping (README, `.gitignore`, license), committed build artifacts, and whether
  a fast check gate is wired. Pass `all` for a health board ranked worst-first.
- **Dogfooding**: after Chime adopted an MIT `LICENSE`, its own doctor gained a
  matching **license probe** (warn when no `LICENSE`/`COPYING` file defines reuse
  terms) — the tool now encodes the lesson Chime learned about itself, and running
  `project_doctor chime` scores Chime a clean **A**.
- **Implementation**: one `src/tools/project-doctor.ts` + one registry row. Scoring
  and toolchain detection are pure functions; findings are gathered by thin `git`
  read commands and directory listings. Every fix is returned as a next-step command,
  never run.
- **Tests**: 17 offline tests — pure scoring/grade bands, toolchain detection, each
  probe driven by a fake git, and a real temp-directory diagnosis.
- **Risk**: low — read-only git/log/ls-files and directory reads; fails closed and
  never mutates.

## 0.0.2

Smoother `chime login`.

- **Capability**: `chime login` now reuses any working gcloud credential — either
  Application Default Credentials **or** a plain `gcloud auth login` — and skips the
  browser when one already works. It only signs in when there is no token, and gives
  clear next steps (check every consent box; try `gcloud auth login`; Workspace
  domains may block the scope) instead of a bare failure.
- **Implementation**: `tokenFrom()` tries the two token sources in order; the Vertex
  transport and login share it. No forced re-login.
- **Tests**: token-source order/fallback covered (`tokenFrom`).
- **Risk**: low — read-only credential checks; nothing saved unless a token works.

## 0.0.1

First public release. Chime is a personal terminal secretary with a small tool
registry and zero runtime dependencies.

- **Capability**: a REPL assistant that reads your intent and calls tools. Tools:
  `colima_disk` (check/reclaim the Docker/Colima VM disk), a read-only project
  secretary (`projects`, `project_status`, `project_check`, `project_health`) over
  a private `~/.chime/projects.json`, and a per-project `memory` notebook under
  `~/.chime/memory`. A deterministic router picks a model tier per turn.
- **Brains**: Anthropic or Gemini by API key, or Vertex AI via `chime login`
  (Google sign-in through gcloud — no key to paste). One `Transport` seam; the
  loop and tools are provider-agnostic.
- **Implementation**: TypeScript on Node 22.18+ native TS, the model APIs over
  native `fetch` (no SDK). One capability = one `src/tools/<name>.ts` + one
  registry row. Registry data is private and local; the code carries none of it.
- **Tests**: 85 offline tests (`node --test`, no network), a no-network dispatch
  smoke, and an opt-in live smoke.
- **Risk**: early days — surfaces may change before 1.0. Secretary tools are
  strictly read-only; state-changing work is returned as a next-step command.
