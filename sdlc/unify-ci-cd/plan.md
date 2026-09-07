# plan.md — chime: one CI/CD shape

Stage 3 of `~/Developer/sdlc/unify-ci-cd/` (the wish for one shape is
signed off by the owner, 2026-09-07). chime is in the last group (row 7
of the spec, with cool-workflow): it runs on GitHub, so `runs-on:
ubuntu-latest` is right there and the label rule does not apply. This
file is the plan only. No workflow file is changed and no code is
changed by this PR.

## What was checked (2026-09-07, `origin/main` at `d4e66a48`)

- One file in `.github/workflows/`: `ci.yml`. No `.gitea/workflows/`
  directory.
- `ci.yml` today:
  - `name: ci` (small letters).
  - Triggers: `push` to `main`, `pull_request`. Already right.
  - One job, id `check`, no job `name:` key. **Already right** — this
    is the one part of R3 that needs no change.
  - Steps: `actions/checkout@v4` → `actions/setup-node@v4` (node
    22.18) → `npm ci` → `npm run check` (tsc, type-check only) →
    `npm test` (`node --test`) → `npm run smoke:secretary`.
  - No `lint` script in `package.json`, and no `build` step in CI.
    `check` runs `tsc -p tsconfig.check.json`, which has `noEmit:
    true` — it is a type-check, not a build. chime runs straight off
    `.ts` source (Node 22.18+ strips types at run time, per the
    comment on the `setup-node` step), so no `dist/` is built or
    needed for CI to pass. `smoke:secretary` runs `node
    scripts/smoke-secretary.ts` directly.
  - No `gitea.*`, no `hashFiles(` anywhere in the file. Already right.
  - No `secrets.*` line at all. Already right.
- No branch protection on `main`:
  `gh api repos/coo1white/chime/branches/main/protection` → 404,
  "Branch not protected". So there is no required-status string to
  break, and no owner rename step is needed here (spec §5.2 is about
  the case where one exists; chime is the other case).
- Package manager today: `package-lock.json` (npm), `npm ci` in CI. No
  `packageManager` field in `package.json`, no `bun.lock`,
  no `bunfig.toml`. The bun move for chime has **not** happened, and
  chime is not yet a row in `~/Developer/sdlc/unify-package-manager-
  bun/spec.md` §4's per-project order table (checked: only whalewake,
  cool-workflow, cool-english, cool-code-platform,
  cool-tunnel-server are listed there).
- No stack-gate / CI-shape test anywhere in `test/`. The `gate` hits
  found there (`project-check.test.ts`, `project-doctor.test.ts`,
  `repo-slim.test.ts`) are about chime's own product features (it is a
  tool that checks *other* projects), not about chime's own
  `.github/workflows/`.
- `package.json` has no `engines` field.

## File count (spec R2)

Stays at one file: `ci.yml` only. chime has no release automation and
no scheduled job today, so `release.yml` and `scheduled.yml` are not
added — R2 only asks for them "when a repo has that work."

## `ci.yml` changes (spec R3, R5, R6)

| Part | Today | After | Why |
|---|---|---|---|
| workflow `name:` | `ci` | `CI` | R3 |
| job id | `check` | `check` (no change) | already right |
| job `name:` | none | none (no change) | already right |
| `actions/checkout@v4` | floating tag | `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1` | R5, pin table |
| `actions/setup-node@v4` | floating tag | `actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0` | R5, pin table; the `with: node-version: "22.18"` line does not change |
| step order | checkout → toolchain → install → check → test → smoke | same | matches R3's order once "lint" (chime has none) and a stand-alone "build" (chime has none — `check` is the type-check step and stands in for it, `smoke:secretary` runs off source) are named as absent, not skipped by mistake |
| triggers | push to `main`, `pull_request` | no change | already right |
| `runs-on` | `ubuntu-latest` | no change | GitHub-hosted; spec §4 row 7 says the label rule does not hold here |

No `concurrency` block exists today and none is added — R3 (amended
2026-09-07) does not ask for one, and no repo measurement says
`cancel-in-progress` does anything useful on a GitHub `pull_request`
run for a job this short.

Since branch protection is unset (measured above), there is no
required-status context to rename. If the owner turns on protection
for `main` later, the context to require is `CI / check
(pull_request)` (spec R3), read straight off the new `name:` and job
id — no further plan is needed for that step.

## The bun move — order, not scope

R8 says JS repos install with `bun install --frozen-lockfile`. chime
still has `package-lock.json` and no `packageManager` pin, and (as
found above) chime has no plan yet under
`sdlc/unify-package-manager-bun/`. This CI plan does **not** change
the install line from `npm ci` to bun: doing that before the lockfile
itself moves would break the one green run this packet needs as
proof, since there would be no `bun.lock` to install from.

**Order:** a `sdlc/unify-package-manager-bun/plan.md` for chime is
written and approved first (adds chime as a row in that spec's §4
table, produces `bun.lock`, the `packageManager` pin, and the proof
step in that spec's §3). Only then does a small follow-up to this
repo's `ci.yml` swap `npm ci` → `bun install --frozen-lockfile` (with
`oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0`
added as a step before it, per the pin table). Until that lands, `npm
ci` in `ci.yml` is correct and not a gate break — R8 binds "JS repos"
to the bun helper once they have made that move, and the unify-
package-manager-bun spec's own per-project order is the thing that
says when a repo has made it.

## The gate test (spec R9)

None exists today. One small file joins this packet:
`test/ci-shape-gate.test.ts`, using the same `node --test` runner as
every other test here (no new framework, no YAML library — plain
`fs.readFileSync` and regex, per R9 and `ops/gitea/docs/gate-
check.md`).

Constants for this repo (the one allowed difference from the shared
gate, per spec §5.4 — the label set, since chime runs on GitHub):

```ts
const PINS = [
  "3d3c42e5aac5ba805825da76410c181273ba90b1", // checkout v7.0.1
  "820762786026740c76f36085b0efc47a31fe5020", // setup-node v7.0.0
];
const NAMES = ["ci.yml"]; // chime has no release.yml / scheduled.yml yet
const LABELS = ["ubuntu-latest"]; // GitHub-hosted: spec §5.4
```

Checks (same seven asserts as `ops/gitea/docs/gate-check.md`, with
item 4/6's label list narrowed to `LABELS` above and the
`ubuntu-`/`macos-latest` forbidden-string check dropped for the same
reason cool-workflow's gate drops it — `ubuntu-latest` is the right
value on GitHub, not a leftover):

1. no `.gitea/workflows/` directory;
2. file names ⊆ `NAMES`;
3. `ci.yml` has a job id `check`;
4. every `runs-on:` value ∈ `LABELS`;
5. every `uses:` line matches `^[^@]+@[0-9a-f]{40} # v` and the SHA is
   in `PINS`;
6. no `gitea.`, no `hashFiles(`;
7. no `secrets.CT_GITEA_TOKEN`, `CI_VENDOR_TOKEN`, `AUTOMERGE_TOKEN`,
   `RENOVATE_TOKEN`, `secrets.GITHUB_TOKEN` (write `${{ github.token
   }}` if a job ever needs a token — none does today).

Bite proof: the test copies `.github/workflows/ci.yml` text into a
string, plants one fault per check (seven variants), and asserts the
check function returns false / throws on each, then true on the real
file. This is the same shape as the TypeScript example in
`ops/gitea/docs/gate-check.md`, sized to chime's one file.

## Secrets (R7)

Nothing to do. `ci.yml` uses no secret today, and this packet adds
none — no scheduled or release job exists yet that would need
`github.token` or a `REPO_TOKEN`.

## Proof (spec §5.3, "one real run")

The PR that carries this plan's code is its own proof: a real
`pull_request` run of the changed `ci.yml` (new pins, new `name: CI`)
plus the new gate test running inside `npm test`. No push to `main`
tag or dispatch is needed — chime has no `release.yml` /
`scheduled.yml` to prove.

## Cleanup candidates (checked against `sdlc/cleanup-stale-content/intent.md`)

The intent's 2026-09-07 table counts, for chime: pnpm 9 files,
Rust/cargo 9 files, old labels (`ubuntu-`/`macos-latest`) 1 file. All
three were re-measured on `origin/main` above with `git grep`. None of
them is stale by the intent's own test ("says something about the
present that the measured tree contradicts"):

- **pnpm, 9 files** (`projects.example.json`, `src/projects.ts`,
  `src/tools/disk-maintenance.ts`, `src/tools/project-doctor.ts`,
  `src/tools/repo-slim.ts`, `test/disk-maintenance.test.ts`,
  `test/project-check.test.ts`, `test/projects-tool.test.ts`,
  `test/projects.test.ts`) — chime is a tool that reads and manages
  *other* people's projects; `pnpm` there names a package manager
  chime can detect and run for those other projects, a real feature.
  chime's own build has never used pnpm. Not stale.
- **Rust/cargo, 9 files** (`CHANGELOG.md`, `README.md`,
  `projects.example.json`, `src/projects.ts`,
  `src/tools/project-doctor.ts`, `src/tools/repo-slim.ts`,
  `test/project-doctor.test.ts`, `test/projects-tool.test.ts`,
  `test/projects.test.ts`) — same reason: chime's toolchain-detector
  and version-reader support Rust/Cargo projects it might be pointed
  at. chime itself has no `Cargo.toml`. Not stale. (Two more grep hits,
  in `src/ledger.ts` and `src/tools/repo-slim.ts:469`, are the English
  word "trust"/"trusted" — a substring match on "rust", not a mention
  of the language. Not part of the count and not real hits.)
- **Old label, 1 file** (`ubuntu-latest` in `ci.yml`) — correct as-is:
  chime is GitHub-hosted, and the spec (§4 row 7, §5.4) says
  `ubuntu-latest` is the right value there, not a leftover from a
  Gitea move.

No cleanup packet is needed for chime beyond what this CI plan already
does (`name: ci` → `CI` is a CI-shape fix, not a stale-doc fix).

## Packet (one PR, plan and code together)

| # | Directory | Work | Proof |
|---|---|---|---|
| C1 | `.github/workflows/`, `test/` (new gate test), `sdlc/unify-ci-cd/` | `name: CI`; pin `checkout` and `setup-node`; add `test/ci-shape-gate.test.ts` with its seven bite proofs; this file | CI green on the PR's own `pull_request` run |

Directory rule: this is the only packet in its batch touching
`.github/workflows/` or `test/` in chime.

## Acceptance

- `ci.yml`: `name: CI`, job id `check`, both `uses:` lines pinned to
  the SHAs in `ops/gitea/docs/actions-pins.md`, no `gitea.`, no
  `hashFiles(`, no old token alias, no `secrets.GITHUB_TOKEN`.
- `test/ci-shape-gate.test.ts` exists, passes, and its seven bite
  proofs each go red on their planted fault.
- `npm test` (which now includes the gate test) is green on the PR's
  real `pull_request` run.
- This file reflects the final diff at review, per the spec's own
  acceptance line.
