import { existsSync, readdirSync } from "node:fs";
import type { Capability, HandlerContext, JsonSchema, ToolResultPayload } from "../types.ts";
import { findProject, loadProjects, projectPath, type Project } from "../projects.ts";

// The doctor: react.doctor's core idea, made language-agnostic and read-only.
// One call auto-detects the project's toolchain, runs a battery of independent,
// NON-MUTATING health probes (git hygiene, dependency pinning, housekeeping,
// staleness), then aggregates them into a 0-100 score + letter grade with the
// findings sorted worst-first, each carrying the exact next-step command to fix
// it. Proactive health, not reactive debugging — and Chime never runs a fix, it
// hands you the command.

export type Severity = "fail" | "warn" | "ok" | "skip";

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  detail?: string;
  fix?: string; // the exact next-step command/action, never run by Chime
}

// Per-severity score penalty. Kept uniform and severity-driven so scoring stays a
// pure, obvious function — a repo loses 20 per real issue, 8 per soft warning.
export const SEVERITY_WEIGHT: Record<Severity, number> = { fail: 20, warn: 8, ok: 0, skip: 0 };

const SEVERITY_RANK: Record<Severity, number> = { fail: 0, warn: 1, ok: 2, skip: 3 };

const GIT_TIMEOUT_MS = 15_000;
const STALE_DAYS = 90;

// --- Toolchain auto-detection (marker file -> toolchain + expected lockfiles) ---

interface Toolchain {
  id: string;
  label: string;
  manifest: string;
  locks: string[]; // filenames that count as a pinned dependency graph
}

// First match wins. `locks: [manifest]` means the manifest IS the pin (nothing to
// generate), so the lockfile probe is a no-op for that toolchain.
const TOOLCHAINS: Toolchain[] = [
  { id: "node", label: "Node / JavaScript", manifest: "package.json", locks: ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"] },
  { id: "rust", label: "Rust / Cargo", manifest: "Cargo.toml", locks: ["Cargo.lock"] },
  { id: "python", label: "Python", manifest: "pyproject.toml", locks: ["poetry.lock", "uv.lock", "pdm.lock", "requirements.txt"] },
  { id: "python-req", label: "Python", manifest: "requirements.txt", locks: ["requirements.txt"] },
  { id: "go", label: "Go modules", manifest: "go.mod", locks: ["go.sum"] },
  { id: "ruby", label: "Ruby / Bundler", manifest: "Gemfile", locks: ["Gemfile.lock"] },
];

// Pure: given the set of root filenames, name the toolchain (or "unknown").
export function detectToolchain(files: Set<string>): Toolchain | undefined {
  return TOOLCHAINS.find((t) => files.has(t.manifest));
}

// --- Pure scoring ---

// Score is 100 minus the summed penalties, floored at 0; the grade is the usual
// A-F banding. Both are pure functions of the findings — trivially testable.
export function scoreFindings(findings: Finding[]): { score: number; grade: string } {
  const penalty = findings.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0);
  const score = Math.max(0, 100 - penalty);
  const grade = score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F";
  return { score, grade };
}

function summarize(findings: Finding[]): string {
  const fails = findings.filter((f) => f.severity === "fail").length;
  const warns = findings.filter((f) => f.severity === "warn").length;
  if (fails === 0 && warns === 0) return "healthy — no issues found";
  const parts: string[] = [];
  if (fails) parts.push(`${fails} issue${fails === 1 ? "" : "s"}`);
  if (warns) parts.push(`${warns} warning${warns === 1 ? "" : "s"}`);
  return parts.join(", ");
}

// --- Read-only probes -------------------------------------------------------

function rootFiles(dir: string): Set<string> {
  try {
    return new Set(readdirSync(dir));
  } catch {
    return new Set();
  }
}

// Soft git: a probe must never throw. Non-zero / spawn error -> {ok:false}.
function git(ctx: HandlerContext, path: string, args: string[]): { ok: boolean; out: string } {
  const r = ctx.runCommand("git", ["-C", path, ...args], { timeoutMs: GIT_TIMEOUT_MS });
  if (r.status !== 0 || r.error) return { ok: false, out: (r.stderr || r.error || "").trim() };
  return { ok: true, out: r.stdout.trim() };
}

// Directories that should never be committed — build output and vendored deps.
const ARTIFACT_PATHS = ["node_modules", "dist", "build", "out", "target", ".next", "coverage"];

// Collect every finding for one project. Git-dependent probes short-circuit to a
// single "not a repo" fail when there is no .git, so we never shell out blindly.
export function probe(p: Project, ctx: HandlerContext, files: Set<string>, path: string): Finding[] {
  const findings: Finding[] = [];
  const has = (re: RegExp) => [...files].some((f) => re.test(f));

  // 1. Version control — the ground floor of project health.
  const isRepo = existsSync(`${path}/.git`) || git(ctx, path, ["rev-parse", "--is-inside-work-tree"]).ok;
  if (!isRepo) {
    findings.push({ id: "git", severity: "fail", title: "not under version control", fix: "git init && git add -A && git commit -m 'initial commit'" });
  } else {
    findings.push({ id: "git", severity: "ok", title: "under version control" });

    // 2. Clean working tree.
    const porcelain = git(ctx, path, ["status", "--porcelain"]);
    if (porcelain.ok && porcelain.out !== "") {
      const n = porcelain.out.split("\n").length;
      findings.push({ id: "clean-tree", severity: "warn", title: `${n} uncommitted change${n === 1 ? "" : "s"}`, fix: "git add -A && git commit" });
    } else {
      findings.push({ id: "clean-tree", severity: "ok", title: "working tree clean" });
    }

    // 3. In sync with upstream (ahead/behind). No upstream -> skip, not a defect.
    const lr = git(ctx, path, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
    if (lr.ok) {
      const [behind = "0", ahead = "0"] = lr.out.split(/\s+/);
      if (Number(ahead) > 0 && Number(behind) > 0) {
        findings.push({ id: "sync", severity: "warn", title: `diverged from upstream (${ahead} ahead, ${behind} behind)`, fix: "git pull --rebase then git push" });
      } else if (Number(ahead) > 0) {
        findings.push({ id: "sync", severity: "warn", title: `${ahead} unpushed commit${ahead === "1" ? "" : "s"}`, fix: "git push" });
      } else if (Number(behind) > 0) {
        findings.push({ id: "sync", severity: "warn", title: `${behind} commit${behind === "1" ? "" : "s"} behind upstream`, fix: "git pull" });
      } else {
        findings.push({ id: "sync", severity: "ok", title: "in sync with upstream" });
      }
    } else {
      findings.push({ id: "sync", severity: "skip", title: "no upstream tracking branch" });
    }

    // 4. Staleness — days since the last commit. A proactive-health signal.
    const last = git(ctx, path, ["log", "-1", "--format=%ct"]);
    const ts = last.ok ? Number(last.out) : NaN;
    if (Number.isFinite(ts) && ts > 0) {
      const days = Math.floor((ctx.now().getTime() - ts * 1000) / 86_400_000);
      if (days > STALE_DAYS) {
        findings.push({ id: "staleness", severity: "warn", title: `no commits in ${days} days`, detail: `last commit ${days} days ago`, fix: "review whether this project is still active" });
      } else {
        findings.push({ id: "staleness", severity: "ok", title: `active (last commit ${days} day${days === 1 ? "" : "s"} ago)` });
      }
    }

    // 5. Build artifacts / vendored deps must not be tracked.
    const tracked = git(ctx, path, ["ls-files", "--", ...ARTIFACT_PATHS]);
    if (tracked.ok && tracked.out !== "") {
      const dirs = [...new Set(tracked.out.split("\n").map((l) => l.split("/")[0]))].filter(Boolean);
      findings.push({ id: "artifacts", severity: "warn", title: `build output committed (${dirs.join(", ")})`, fix: `git rm -r --cached ${dirs.join(" ")} and add to .gitignore` });
    }
  }

  // 6. Housekeeping — a README, a .gitignore, and a license.
  findings.push(
    has(/^readme(\.|$)/i)
      ? { id: "readme", severity: "ok", title: "has a README" }
      : { id: "readme", severity: "warn", title: "no README", fix: "add a README.md describing the project" },
  );
  findings.push(
    files.has(".gitignore")
      ? { id: "gitignore", severity: "ok", title: "has a .gitignore" }
      : { id: "gitignore", severity: "warn", title: "no .gitignore", fix: "add a .gitignore" },
  );
  findings.push(
    has(/^(licen[sc]e|copying)(\.|$)/i)
      ? { id: "license", severity: "ok", title: "has a license" }
      : { id: "license", severity: "warn", title: "no license — reuse terms undefined", fix: "add a LICENSE file (e.g. MIT) and declare it in the manifest" },
  );

  // 7. Dependency pinning — a manifest with no lockfile is a reproducibility hole.
  const tc = detectToolchain(files);
  if (tc && !(tc.locks.length === 1 && tc.locks[0] === tc.manifest)) {
    const pinned = tc.locks.some((l) => files.has(l));
    findings.push(
      pinned
        ? { id: "lockfile", severity: "ok", title: "dependencies are pinned" }
        : { id: "lockfile", severity: "warn", title: `no lockfile for ${tc.label}`, fix: `install to generate a lockfile (one of: ${tc.locks.join(", ")})` },
    );
  }

  // 8. A fast gate Chime can run — the project should declare a check command.
  findings.push(
    p.check && p.check.length > 0
      ? { id: "check-wired", severity: "ok", title: "fast check gate configured" }
      : { id: "check-wired", severity: "warn", title: "no fast check gate", fix: "add a `check` command to this project's registry row" },
  );

  return findings;
}

// Worst-first ordering so the top of the list is always the most actionable.
function ranked(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

// --- Orchestration ----------------------------------------------------------

export function diagnose(p: Project, ctx: HandlerContext): ToolResultPayload {
  const path = projectPath(p, ctx.home);
  if (!existsSync(path)) {
    return { ok: false, name: p.name, error: "path not found" };
  }
  const files = rootFiles(path);
  const tc = detectToolchain(files);
  const findings = ranked(probe(p, ctx, files, path));
  const { score, grade } = scoreFindings(findings);
  const nextSteps = findings.filter((f) => f.fix).map((f) => f.fix as string);

  return {
    ok: true,
    name: p.name,
    kind: p.kind,
    toolchain: tc ? tc.label : "unknown",
    score,
    grade,
    summary: summarize(findings),
    findings: findings.map((f) => ({
      severity: f.severity,
      title: f.title,
      ...(f.detail ? { detail: f.detail } : {}),
      ...(f.fix ? { fix: f.fix } : {}),
    })),
    nextSteps,
  };
}

// Compact one-line card for the `all` health board.
function card(p: Project, ctx: HandlerContext): Record<string, unknown> {
  const d = diagnose(p, ctx);
  if (!d.ok) return { name: p.name, error: d.error };
  return { name: p.name, score: d.score, grade: d.grade, summary: d.summary };
}

const inputSchema: JsonSchema = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "a project name (e.g. web-app), or 'all' for a health board across every project",
    },
  },
  required: ["name"],
  additionalProperties: false,
};

function handler(input: Record<string, unknown>, ctx: HandlerContext): ToolResultPayload {
  const name = String(input.name ?? "");
  if (!name) return { ok: false, error: "name is required (a project name or 'all')" };
  const reg = loadProjects(ctx.home);

  if (name === "all") {
    const projects = reg.map((p) => card(p, ctx)).sort((a, b) => (Number(a.score ?? -1)) - (Number(b.score ?? -1)));
    return { ok: true, name, projects };
  }

  const p = findProject(name, reg);
  if (!p) return { ok: false, name, error: `unknown project: ${name}` };
  return diagnose(p, ctx);
}

export const projectDoctor: Capability = {
  name: "project_doctor",
  description:
    "Run a whole-project health diagnosis and report a 0-100 score with a letter grade and prioritized, actionable findings. Auto-detects the toolchain (Node, Rust, Python, Go, Ruby) and runs read-only probes: git hygiene (repo? clean? in sync? stale?), dependency pinning (lockfile present?), housekeeping (README, .gitignore, license), committed build artifacts, and whether a fast check gate is wired. Call this when the user asks 'how healthy is X', 'diagnose X', 'what's wrong with X', or 'score all my projects' (pass 'all' for a leaderboard). Strictly read-only: it runs git status/log/ls-files and reads directory listings; every fix is returned as a next-step command, never run.",
  inputSchema,
  handler,
};
