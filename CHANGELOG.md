# Changelog

All notable changes to Chime are noted here. Versions are small on purpose —
one capability per step, slow and steady.

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
