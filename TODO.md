# Chime TODO — committed backlog

This file is the committed backlog: capabilities agreed on but not built
yet, one item per capability, in CHANGELOG voice. Runtime "Next Run" notes
stay in `~/.chime/memory/<project>.md` — this file is only for work that is
decided and waiting. Delete an item when its capability ships (the
CHANGELOG entry takes over as the record).

---

## 1. `repo_slim` stale-facts detection (rot class 5)

**Capability.** `scan` already lists stale-facts as a documented gap
(`notImplemented`: "needs semantic comparison of a living doc's claims
against the tree — not implemented; route candidate docs through a human
or LLM review pass instead of this scan"). This item narrows that gap —
not closes it — by adding two mechanically checkable claim classes,
staying inside `repo_slim`'s existing no-model, offline-fixture-testable
design (the same discipline `disk_maintenance`'s tests already hold to):

- **dead path reference** — a markdown file names a repo-relative path in
  a backtick span, a markdown link, or a fenced code block, and that path
  is not in `git ls-files`. Flag it.
- **dead tool/command reference** — a markdown file shows a command whose
  first token doesn't match any registered `Capability.name` in
  `src/tools/index.ts`. Flag it.

Free-form prose claims (the majority of real stale facts — an outdated
sentence describing behavior, not a broken reference) stay out of scope
and stay in `notImplemented`; this item only shrinks what needs a human
or LLM pass, it doesn't remove the need for one.

**How it works.** A new check inside `scan`'s existing per-file loop,
markdown files only, using the `content` string already read into
memory — no new dependency, no model call. Verdict is always `review`,
confidence always `low` (a stale claim needs a human to read and rewrite
it, never an auto-`delete`), with the evidence naming the exact dead
reference. Only clearly-structured references are checked (backtick
spans, markdown links, fenced code) — to keep false positives rare,
a candidate string must look like a real repo-relative path (contains a
`/` and either a plausible extension or matches an existing tracked
directory's prefix) before it's treated as a path claim at all, so
placeholder syntax like `` `path/to/file` `` in an example doesn't
falsely flag.

**Implementation.** Extend `src/tools/repo-slim.ts`'s `scan` loop (the
same file PRs #16–#19 built); narrow the `NOT_IMPLEMENTED` note to say
only free-form prose claims remain uncovered.

**Tests.** Offline fixtures, no network, no model: a doc with a backtick
path to a file that doesn't exist (flagged, low confidence, review); a
doc referencing a real, existing path (not flagged); a doc naming a
command not in the tool registry (flagged); a placeholder-style path in
prose (`path/to/file`, no real extension or directory match — not
flagged, to prove the false-positive guard holds).

**Risk.** False "stale" flags on illustrative/placeholder references.
Mitigated by requiring a plausible-path shape before treating a string as
a claim at all, and by capping every finding at confidence `low` /
verdict `review` — this item can never produce a `delete`, so the worst
case is a human spends a minute confirming a doc is actually fine.
