# Chime TODO — committed backlog

This file is the committed backlog: capabilities agreed on but not built
yet, one item per capability, in CHANGELOG voice. Runtime "Next Run" notes
stay in `~/.chime/memory/<project>.md` — this file is only for work that is
decided and waiting. Delete an item when its capability ships (the
CHANGELOG entry takes over as the record).

---

## 1. `repo_slim` — read-only repo slim-down audit + plan + ledger handoff (target v0.0.5+)

**Capability.** Point chime at a configured project and get the full repo
slim-down workflow proven on cool-workflow (2026-07-13, PRs #488–#500):
a file-by-file deadness/duplication audit with evidence, a risk-tiered
cleanup plan, and — because chime never edits code — execution handed to a
coding agent through the existing `ledger` as verifiable proposals.

**How it works — three actions on one tool:**

- `scan` (read-only): walk `git ls-files` of the project and classify every
  file by the rot taxonomy, or KEEP with its pin named:
  1. orphan tooling — a script/helper/fixture with no consumer
  2. superseded draft — research/draft copy whose deliverable shipped
  3. version-era snapshot — prompts/notes/"pending" lists tied to a
     shipped version
  4. stub/copy — a file whose content lives elsewhere (one source + a
     link is the rule)
  5. stale facts — a living doc whose claims contradict the tree
  6. duplicate doc pair — two docs owning one subject; name which absorbs
     which
  Pin classes the scanner MUST check before calling anything dead:
  imports/requires; spawn/exec strings; package.json bin/scripts/files;
  CI workflow steps; doc links; generator + drift-gate pairs; ecosystem
  path conventions (a Homebrew `Formula/`, `.github/`, root agent files);
  append-only audit records (ALWAYS exempt, never flagged). Two pin
  classes are not statically findable — content pins (a test doing
  readFileSync + assert on the file) and runtime path conventions (a
  `man <topic>` verb serving `docs/<topic>.7.md`) — so every verdict
  carries a confidence, and the report states plainly: **the target
  repo's full test suite against the COMMITTED head is the final arbiter,
  not this scan. mtime is never a signal.**
- `plan`: group findings into the four risk tiers — (1) delete
  zero-consumer files, (2) merge duplicates into their one home, (3) fix
  stale facts in living docs, (4) history purge, which ALWAYS needs an
  explicit owner yes. Returns a `planHash` over the exact batch list (the
  `disk_maintenance` pattern) so nothing downstream acts on a stale plan.
- `handoff`: emit one `ledger propose` entry per batch (reusing the
  `ledger` tool), carrying the file list, the evidence, the planHash, and
  the verification contract for the executor: full suite on the committed
  head; rebase-not-merge on conflicts; one PR per batch; list-confirm
  before any destructive step. The cw-side coding agent picks proposals
  up and lands PRs; chime tracks progress read-only via `ledger list`
  resolution (pending/approved/rejected/contested).

**Implementation.** New `src/tools/repo-slim.ts` + one registry line in
`src/tools/index.ts` + a SYSTEM_PROMPT blurb in `src/repl.ts` + tests.
Templates to copy: `src/tools/self-iteration.ts` (read-only project-scoped
audit shape), `src/tools/disk-maintenance.ts` (scan → planHash → gated
next step), `src/tools/ledger.ts` (the handoff leg). Read-only red line
holds: `repo_slim` never deletes, never writes to the project — its only
outputs are reports and ledger entries.

**Tests.** Offline fixture repos (no network, no model): an orphan script
(flagged, class 1); a stub doc pointing at its real copy (class 4); an
append-only audit dir that must NOT be flagged; a content-pinned file (a
fixture test reads it byte-wise) that must come back LOW confidence, not
DELETE; a planHash mismatch that must refuse the handoff.

**Risk.** False DELETE verdicts. Mitigated three ways: per-verdict
confidence + the suite-is-arbiter contract written into every proposal +
the owner-yes gate on history purges. Chime itself never executes, so the
worst case is a bad proposal a reviewer rejects — fail-closed end to end.

## 2. `repo_slim rules` — anti-regrowth rules emitter (small; can ride with item 1)

**Capability.** After a slim-down, the repo needs standing rules so the
same clutter classes cannot regrow. This action emits the four File
Lifecycle rules (orphan tooling / superseded drafts / version-era
snapshots / stub copies, each with its one-line standing rule) plus the
append-only-records exemption, as a ready-to-commit markdown snippet for
the target repo's agent rules file — the same section cool-workflow's
AGENTS.md gained on 2026-07-13.

**Implementation.** A fourth action on the same tool; the rules are data
(a template string), not logic. **Tests.** Snapshot the emitted snippet.
**Risk.** None — pure text output.

## 3. Exercise `ledger` end to end from the chime side

**Capability.** The cross-agent loop is proven from the cw side; the chime
side has never driven it live. Steps: (operator, web UI) scope the chime
environment into `coo1white/handoff` and give it a git token; then from
chime, `ledger list` the shared inbox (fail-closed), and produce entries
`--from chime --to cool-workflow`. `repo_slim handoff` (item 1) is its
first real producer, so landing item 1 and this item together gives the
full loop a real workload.

**Risk.** None to code — the remaining step is operator access setup.
