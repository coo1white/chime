# Chime

A personal terminal conversational assistant. You talk to it; a Claude or Gemini
"brain" reads your intent, calls registered tools, and answers in plain language.
Zero runtime dependencies — TypeScript on Node, the model APIs over native `fetch`
(no SDK).

Chime manages the Docker/Colima VM's disk (a front door to the
[`colima-disk-maintenance`](../colima-disk-maintenance) launchd job, plus an
opt-in deep Colima datadisk compactor) and acts as a
**read-only secretary** over every project under `~/Developer` — it knows each repo,
reports live git/version state, runs each repo's own fast check, and pings the
deployed ones. More tools are added one module at a time.

## Setup

Requires Node 22.18+ (native TypeScript, `fetch`, `node:test`).

```sh
npm install                          # dev deps only: typescript, @types/node
npm run build                        # tsc → dist/
npm link                             # once, to put `chime` on your PATH
```

Then pick **one** brain:

```sh
# A) Google sign-in, no key to store (recommended) — needs the gcloud CLI + a GCP project
chime login                          # opens the Google popup; saves ~/.chime/config.json (Vertex AI)

# B) an API key in the env
export GEMINI_API_KEY=...            # Google Gemini  (default model gemini-2.5-flash)
export ANTHROPIC_API_KEY=sk-ant-...  # Claude         (default model claude-opus-4-8)
```

```sh
chime
```

Chime picks the backend for you: `CHIME_BACKEND` if set, else a **saved `chime login`**
(it *pins* the backend — a stray `GEMINI_API_KEY` in your shell won't silently override
it), else a present API key. `chime login` uses gcloud Application Default Credentials,
so after signing in once you never paste a key. Enable the **Vertex AI API** for the
project first. (No `npm link`? use `npm start`.)

## Use

```
chime> how's my disk space?
chime> preview a docker cleanup
chime> preview deep colima compaction
chime> exit
```

It prefers a read-only **status** or a **preview** (dry-run) before anything that
changes state, and explains what it ran.

### Colima disk maintenance

`colima_disk` has two levels:

- **Light cleanup**: `status`, `preview`, and `run` keep using the existing
  `colima-disk-maintenance` path for safe reclaim work such as dangling-image cleanup
  and `fstrim`.
- **Deep compaction**: `compact_preview` inspects the Colima raw datadisk and Docker
  state without changing anything. `compact_run` requires `confirm: true`, saves Docker
  manifests under `~/.chime/colima-compact/<timestamp>/`, deletes only regenerable
  Docker build cache and unused images, zero-fills free space, sparse-compacts
  `~/.colima/_lima/_disks/colima/datadisk` with `qemu-img`, then starts Colima and
  verifies containers, volumes, Docker space, and the final datadisk size before
  deleting the rollback disk.

Deep compaction preserves running containers, the images they use, and Docker volumes.
It does not shrink the datadisk's logical 100G capacity; it reduces the host-side
physical space used by the sparse raw file.

## Project secretary

Chime holds a **registry** of the user's repos ([`src/projects.ts`](src/projects.ts)) —
one declarative row per project (path, kind, four-beat mantra, remotes, deployed URL,
version source, and the repo's own non-mutating check command). Stable facts live in
the row; volatile facts (the live version, git state) are read at call time, so a row
never goes stale. Four read-only tools work over it:

| tool | asks | does (read-only) |
|---|---|---|
| `projects` | "what projects do I have?", "what's X's mantra/command?" | list every repo, or one project's card |
| `project_status` | "is X dirty? what branch/version?" | live `git` branch/dirty/HEAD + version, one repo or `all` |
| `project_check` | "is X green / does it still typecheck?" | runs the repo's own fast lint/typecheck, reports PASS/FAIL |
| `project_doctor` | "how healthy is X?", "diagnose X", "score all my projects" | auto-detects the toolchain and scores the repo 0–100 (A–F) from read-only health probes, worst-first, each with a fix command |
| `project_health` | "is my app up?" | curls the deployed health URL, reports the HTTP code |
| `memory` | "remember X about this repo", "what did we do last time?" | read/append a per-project notebook under `~/.chime/memory` |
| `handoff` | "propose X to codex", "review P1 as gemini", "status of P1", "what's open?" | read/append the shared multi-agent ledger under `~/.chime/handoff` |
| `ledger` | "verify this proposal from cool-workflow", "check my handoff inbox", "propose X to cw", "review ldg-… approved" | verify or mint `cw ledger`-compatible, sha256-sealed handoff entries — fail-closed |
| `self_iteration` | "self-iterate on Chime", "what should we improve next time?" | read-only workflow review: git scope, what to keep, what to change, next steps |

```
chime> list my projects
chime> status of web-app
chime> is web-app green?
chime> how healthy is web-app?
chime> score all my projects
chime> is web-app up?
chime> self-iterate on chime
```

### The doctor — one score, prioritized fixes

`project_doctor` internalizes the core idea behind [react.doctor](https://react.doctor)
(one command → a whole-project health score with actionable diagnostics) and makes it
**language-agnostic** and **read-only**. It auto-detects the toolchain (Node, Rust,
Python, Go, Ruby) from marker files, runs a battery of independent, non-mutating
probes, then aggregates them into a **0–100 score + letter grade** with the findings
sorted worst-first — each carrying the exact next-step command to fix it. The probes:

- **git hygiene** — under version control? working tree clean? in sync with upstream
  (ahead / behind)? stale (no commits in 90+ days)?
- **dependency pinning** — a manifest with no lockfile is a reproducibility hole
- **housekeeping** — a README, a `.gitignore`, and a license (reuse terms defined?)
- **committed build output** — `node_modules`, `dist`, `target`, … shouldn't be tracked
- **a fast gate** — does the project declare a `check` command Chime can run?

Like the rest of Chime it **never mutates**: every fix is returned as a command string
for you to run. Pass `all` for a health board ranked worst-first across every repo.

The registry is **private and local** — Chime reads it from `~/.chime/projects.json`
(it is never committed). Copy [`projects.example.json`](projects.example.json) to
`~/.chime/projects.json` and edit in your own repos. Missing file → Chime just reports
no projects yet.

**Strictly read-only.** Chime never releases, deploys, restarts, or edits code — it has
no tool for that. For anything that changes state it gives the exact next-step command
and lets you run it.

It also **grows with you**: the `memory` tool keeps a per-project notebook under
`~/.chime/memory/<name>.md` (Verified Facts / Failed Attempts / Last Session / Next Run,
the same shape the repos use in `PROJECT_MEMORY.md`), so Chime recalls a project's state
between sessions.

### The handoff ledger — multi-agent, cross-platform collaboration

`handoff` is a **shared, vendor-neutral channel** where any agents — Claude, Codex,
DeepSeek, Gemini, Chime, … — propose changes and review each other. It is Chime's own
data (a JSON ledger under `~/.chime/handoff/ledger.json`) that every agent reads and
appends, so the ledger doesn't care who writes: arbitrary **permutations** of agents
collaborate over it, while Chime stays **read-only on your project code**. The verbs:

- **`propose`** — an agent records a structured change proposal (title, rationale,
  target files, suggested branch) instead of editing code. A coding agent picks up an
  accepted proposal and turns it into a **real PR**. `from`/`to` name the agents;
  `to: all` broadcasts a proposal to the whole panel.
- **`review`** — any agent records a verdict (`approve` / `request-changes` /
  `comment`) about a proposal id or an external PR ref. A proposal can gather reviews
  from **many** agents; its status reflects the **consensus** of the whole panel (net
  of approvals over change-requests), so three approvals outweigh one block and a lone
  block still holds it.
- **`status`** shows one proposal with its review panel and computed consensus;
  **`list`** shows what's open.

The loop: *one agent proposes → a panel of agents reviews → consensus accepts →  a
coding agent opens the PR → another agent proposes next* — mutual review, common
progress, no agent mutating another's code. Because identities are open slugs, a new
platform joins with **no code change** — it just reads and writes the same ledger.

```
chime> propose to all (from codex): unify retry/backoff in http.ts
chime> review P1 approve as gemini
chime> status of P1          # -> panel: claude+gemini approve, deepseek blocks -> accepted
chime> what handoffs are open?
```

### The cross-agent ledger — interop with `cw ledger`

The `ledger` tool lets Chime hand off with [cool-workflow](https://github.com/coo1white/cool-workflow)'s
`cw ledger` — a *different* channel from the local `handoff` board above. Where
`handoff` is Chime's own consensus board, `ledger` speaks cw's **exact** wire
format so two agents scoped to two separate repos exchange **verifiable** entries,
not chat. Each entry is a self-contained JSON object carrying its own **sha256
content digest** and a content-addressed `ldg-<hex>` id; the receiving side runs
`verify` **fail-closed** before acting, so a tampered or malformed entry is refused
and `verify && open-pr` can never proceed on a lie.

```
chime> verify this proposal from cool-workflow   (paste it, or give a file path)
chime> check my handoff inbox                     (uses your configured default dir)
chime> check my handoff inbox at ~/handoff-repo/ledger
chime> propose to cool-workflow: add retry to the fetch path
chime> review ldg-6fd2a38a8a1d2b8c approved — tests pass, scope ok
```

`list` takes a `dir`, but with none given it reads your **default inbox**:
`CHIME_HANDOFF_DIR` if set, else `handoffDir` in `~/.chime/config.json` — so "check
my handoff inbox" needs no path. The result reports `source` (`arg`/`env`/`config`)
so it is always clear which directory was read.

Chime is the "chime" side of cw's documented round-trip — *cw proposes → chime
verifies → chime reviews → cw verifies*. The digest kernel ([`src/ledger.ts`](src/ledger.ts))
is a byte-for-byte port of cw's, checked by tests against entries produced by cw's
own kernel, so an entry sealed on one side always verifies on the other. Like the
rest of the secretary it is **read-only**: `verify`/`list` only read, and
`propose`/`review` only return a sealed entry for you to relay — Chime writes
nothing and mutates no repo.

## Model routing

Each turn, Chime picks a model **tier** by simple deterministic rules (no extra
LLM call), printing the choice to stderr (`[chime] tier=balanced (gemini-2.5-flash)`):

- **strong** for long messages or code/reasoning asks (refactor, debug, analyze,
  "in depth", 分析/重构/设计…)
- **cheap** for short greetings/acks (hi, thanks, 你好…)
- **balanced** otherwise

Force a tier with a leading token: `/strong …`, `/fast …` (`/cheap`), `/balanced …`.
Turn routing off with `CHIME_ROUTER=0` (then it always uses the balanced model).

## Configuration (env)

| var | default | meaning |
|---|---|---|
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | — | use Google Gemini as the brain |
| `ANTHROPIC_API_KEY` | — | use Claude as the brain |
| `CHIME_BACKEND` | auto | force `gemini`, `anthropic`, or `vertex` |
| `CHIME_VERTEX_PROJECT` / `_LOCATION` | from `chime login` / `us-central1` | Vertex AI project + region (no key; uses gcloud token) |
| `CHIME_ROUTER` | on | `0` to disable per-turn routing (always use balanced) |
| `CHIME_TIER_CHEAP` / `_BALANCED` / `_STRONG` | per-backend | override a tier's model id |
| `CHIME_MODEL` | per-backend | the balanced/default model (gemini `gemini-2.5-flash` / claude `claude-sonnet-5`) |
| `CHIME_MAX_TOKENS` | `2048` | max reply tokens |
| `CHIME_MAX_ITERATIONS` | `8` | tool-call rounds per turn (loop guard) |
| `CHIME_HANDOFF_DIR` | from `~/.chime/config.json` `handoffDir` | default shared ledger dir for `ledger list` when no `dir` is given |

Default tiers — gemini: `gemini-2.5-flash-lite` / `gemini-2.5-flash` / `gemini-2.5-pro`;
claude: `claude-haiku-4-5` / `claude-sonnet-5` / `claude-opus-4-8`.

**Backend precedence**: `CHIME_BACKEND` (explicit) > a **saved `chime login`** (pins
the backend) > a present API key. So once you `chime login` (Vertex), a stray
`GEMINI_API_KEY` will **not** silently switch you to the free tier — Chime stays on your
private backend and says so on the startup line. With no saved login and no
`CHIME_BACKEND`, a present key is used (Anthropic wins if both keys are set). Fails
closed if nothing is configured.

## Develop

```sh
npm run check          # tsc typecheck (src + test + scripts)
npm test               # offline test suite (node --test) — no network, no real script
npm run smoke:secretary # no-network proof: dispatch -> registry -> secretary tools
npm run smoke          # opt-in LIVE smoke; needs a key, hits the real API
```

## Architecture

- **`src/registry.ts`** — single source of truth. Each capability row carries both
  its tool definition and its handler; `toAnthropicTools()` derives the model's
  tool list from the same rows `dispatch` routes through, so they can't drift.
  **Adding a feature = one `src/tools/<name>.ts` + one registry entry.**
- **`src/brain.ts`** — the provider-agnostic tool-use loop: ask the model → run any
  tool calls → feed results back → repeat until done, with a hard iteration bound.
- **`src/anthropic.ts` / `src/gemini.ts`** — two `Transport` implementations behind
  one interface (`src/backend.ts` picks one by key). The Gemini adapter translates
  function-calling both ways. Both reuse `src/http.ts` (retry/error mapping). The
  whole loop is tested against a fake transport — no network.
- **`src/dispatch.ts`** — routes one tool call to its handler, fail-closed (errors
  become structured `is_error` results, never crashes).
- Discipline: stdout = assistant output, stderr = diagnostics; fail-closed; zero deps.
