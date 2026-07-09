# Agent instructions

## Resolving merge conflicts

When the base branch has moved on and a rebase or merge hits a
conflict:

- Rebase the work branch onto the base branch; do not merge the base
  branch into the work branch. Force-push only the work branch itself,
  never the base branch.
- Simple, mechanical conflicts may be resolved without asking:
  changelog files (append-only — keep the entries from both sides),
  TODO or docs lists (keep both sides), lockfiles (take the base
  branch's copy, then run the build against it as a check; make a new
  one only if this branch changed the dependency set), and edits on
  near-by lines in unrelated code.
- A semantic conflict is a stop sign: the two sides changed the same
  function or logic, or the conflict touches security-sensitive code
  (wire formats, fail-closed checks, redaction, signing or release
  tooling). Put the two sides in front of the owner and ask; do not
  guess a resolution in that code.
- After any resolution the result is new code: run the project's
  checks again, wait for CI to be green on the new head, and only then
  merge.
- Never resolve a whole conflict with a blanket "ours" or "theirs".
