# Chime TODO — committed backlog

This file is the committed backlog: capabilities agreed on but not built
yet, one item per capability, in CHANGELOG voice. Runtime "Next Run" notes
stay in `~/.chime/memory/<project>.md` — this file is only for work that is
decided and waiting. Delete an item when its capability ships (the
CHANGELOG entry takes over as the record).

---

## 1. Exercise `ledger` end to end from the chime side

**Capability.** The cross-agent loop is proven from the cw side; the chime
side has never driven it live. Steps: (operator, web UI) scope the chime
environment into `coo1white/handoff` and give it a git token; then from
chime, `ledger list` the shared inbox (fail-closed), and produce entries
`--from chime --to cool-workflow`. `repo_slim handoff` has shipped (PRs
#16–#19) and is chime's first real producer of ledger entries, so this
item is now only waiting on the operator access step to give the full
loop a real workload.

**Risk.** None to code — the remaining step is operator access setup.
