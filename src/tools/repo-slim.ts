import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Capability, HandlerContext, JsonSchema, ToolResultPayload } from "../types.ts";
import { findProject, loadProjects, projectPath } from "../projects.ts";

// repo_slim: a read-only repo slim-down audit. scan classifies every tracked file
// as KEEP (with a pin reason) or a rot-taxonomy DELETE/MERGE/REVIEW candidate with
// an evidence trail; plan groups scan's findings into risk tiers and returns a
// planHash over the exact batch (the disk_maintenance pattern) so a later handoff
// step can refuse to act on a stale plan. This tool NEVER writes to the target
// project — its only outputs are the scan/plan reports themselves. The scan is
// deliberately conservative: two pin classes (a test doing readFileSync on the
// file; a runtime path convention like a `man <topic>` verb serving a doc by
// naming pattern) cannot be found with full certainty by static grep, so any file
// where only a soft signal for one of those was seen comes back confidence:"low"
// and verdict:"review" — never a blind "delete". The target repo's full test
// suite against the committed head is the final arbiter, not this scan; mtime is
// never a signal.

type Confidence = "high" | "low";
type Verdict = "keep" | "delete" | "merge" | "review";
type RotClass = "orphan-tooling" | "superseded-draft" | "version-era-snapshot" | "stub-copy" | "duplicate-doc-pair";

interface Finding {
  path: string;
  verdict: Verdict;
  confidence: Confidence;
  evidence: string;
  rotClass?: RotClass;
  pin?: string;
  pairWith?: string;
}

const ARBITER_NOTE =
  "The target repo's full test suite against the committed head is the final arbiter, not this scan. mtime is never a signal.";

const NOT_IMPLEMENTED = [
  "stale-facts (rot class 5) needs semantic comparison of a living doc's claims against the tree — not implemented; route candidate docs through a human or LLM review pass instead of this scan",
];

const inputSchema: JsonSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["scan", "plan", "rules"],
      description: "scan is read-only file-by-file classification; plan groups scan's findings into risk tiers and returns a planHash over the exact batch; rules emits a ready-to-commit anti-regrowth rules snippet (no project needed)",
    },
    name: { type: "string", description: "project name from ~/.chime/projects.json — required for scan and plan, unused by rules" },
  },
  required: ["action"],
  additionalProperties: false,
};

// The four File Lifecycle rules plus the append-only exemption, as a ready-to-
// commit markdown snippet for a target repo's agent rules file — pure data, no
// logic, so a snapshot test is the only test this needs. One rule per rot-
// taxonomy delete class (duplicate-doc-pair isn't here: merging two docs is a
// one-time cleanup, not a standing rule against regrowth).
const RULES_SNIPPET = `## File Lifecycle rules (repo_slim)

- **Orphan tooling.** A script, helper, or fixture with no consumer — no import,
  no CI step, no doc link, no spawn/exec reference — gets deleted, not kept
  "just in case."
- **Superseded drafts.** Once a draft's deliverable ships, the draft is deleted,
  not archived alongside the shipped copy.
- **Version-era snapshots.** A prompt, note, or "pending" list tied to a shipped
  version is deleted once that version ships; it is not a permanent record.
- **Stub copies.** A file whose content lives elsewhere is deleted — one source
  and a link is the rule, not two copies of the same fact.
- **Exemption: append-only records.** Audit logs, changelogs, and other
  append-only records are never subject to the rules above; they are exempt by
  design.
`;

function insideHome(path: string, home: string): boolean {
  const rel = relative(resolve(home), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// --- ecosystem / append-only allowlists — checked before anything else ------

const ROOT_DOC_NAMES = /^(AGENTS|CLAUDE|README|LICENSE|CONTRIBUTING)(\.[A-Za-z0-9]+)?$/i;
const ECOSYSTEM_PATH_PATTERNS: RegExp[] = [/^\.github\//, /^Formula\/.+\.rb$/];
const APPEND_ONLY_PATTERNS: RegExp[] = [/^CHANGELOG(\.[A-Za-z0-9]+)?$/i, /^HISTORY(\.[A-Za-z0-9]+)?$/i, /(^|\/)audit\//i];

function isEcosystemPin(path: string): boolean {
  if (!path.includes("/") && ROOT_DOC_NAMES.test(path)) return true;
  return ECOSYSTEM_PATH_PATTERNS.some((re) => re.test(path));
}

function isAppendOnly(path: string): boolean {
  return APPEND_ONLY_PATTERNS.some((re) => re.test(path));
}

// --- reference detection ----------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface PinMatch {
  kind: string;
  confidence: Confidence;
}

// Scans every OTHER tracked file's content for a reference to `target`. Hard
// (confidence:"high") pins are structural — an import/require, a spawn/exec
// argument, a CI workflow step, a package.json field, or a markdown link — any
// one of these is a real, checkable dependency, so the first one found short-
// circuits the search. A readFileSync/readFile-style mention is the softer
// "content pin" TODO.md calls out by name: it looks like a reference but a
// dynamic path could just as easily be coincidence, so it only ever downgrades
// confidence, never produces a hard keep on its own.
function findPin(target: string, files: Map<string, string>): PinMatch | undefined {
  const base = basename(target);
  const baseNoExt = base.slice(0, base.length - extname(base).length);
  const needle = escapeRegExp(base);
  const pathNeedle = escapeRegExp(target);
  const parentDir = basename(dirname(target));

  const importRe = new RegExp(`(?:from\\s+|require\\(|import\\()\\s*["'\`][^"'\`]*${escapeRegExp(baseNoExt)}["'\`]`);
  const execRe = new RegExp(`\\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|runCommand)\\s*\\([^)]*["'\`][^"'\`]*${needle}["'\`]`);
  const linkRe = new RegExp(`\\]\\([^)]*(?:${needle}|${pathNeedle})\\)`);
  const readRe = new RegExp(`\\b(?:readFileSync|readFile)\\s*\\([^)]*["'\`][^"'\`]*${needle}["'\`]`);
  const joinRe = parentDir && parentDir !== "." ? new RegExp(`\\bjoin\\([^)]*["'\`]${escapeRegExp(parentDir)}["'\`]`) : undefined;

  let soft: PinMatch | undefined;
  for (const [path, content] of files) {
    if (path === target) continue;

    if (basename(path) === "package.json") {
      try {
        const pkg = JSON.parse(content) as Record<string, unknown>;
        const hay = JSON.stringify([pkg.bin, pkg.scripts, pkg.files]);
        if (hay.includes(base) || hay.includes(target)) return { kind: "package-json-reference", confidence: "high" };
      } catch {
        // unparsable package.json — ignore rather than crash the scan
      }
    }
    if (/^\.github\/workflows\/.+\.ya?ml$/.test(path) && (content.includes(base) || content.includes(target))) {
      return { kind: "ci-workflow-step", confidence: "high" };
    }
    if (extname(path) === ".md" && linkRe.test(content)) return { kind: "doc-link", confidence: "high" };
    if (importRe.test(content)) return { kind: "import-reference", confidence: "high" };
    if (execRe.test(content)) return { kind: "spawn-exec-reference", confidence: "high" };

    if (!soft && readRe.test(content)) soft = { kind: "possible-content-pin", confidence: "low" };
    if (!soft && joinRe?.test(content)) soft = { kind: "possible-runtime-path-convention", confidence: "low" };
  }
  return soft;
}

// --- rot taxonomy (classes 1-4; 6 is cross-file, handled separately) -------

const TOOLING_DIR_RE = /^(scripts?|tools?|bin|hack)\//i;
const TOOLING_EXT_RE = /\.(sh|ts|js|mjs|cjs|py|rb)$/i;
const DRAFT_RE = /draft|wip|scratch|research/i;
const VERSION_ERA_RE = /(^|\/)v?\d+\.\d+(\.\d+)?([-_./]|$)|pending/i;

function isStub(content: string): boolean {
  const lines = content.split("\n").filter((l) => l.trim() !== "");
  if (lines.length > 12) return false;
  return /]\([^)]+\)|\bsee\s+[`"']?[\w./-]+/i.test(content);
}

function classify(path: string, content: string): RotClass | undefined {
  if (TOOLING_DIR_RE.test(path) && TOOLING_EXT_RE.test(path)) return "orphan-tooling";
  if (DRAFT_RE.test(path)) return "superseded-draft";
  if (VERSION_ERA_RE.test(path)) return "version-era-snapshot";
  if (extname(path) === ".md" && isStub(content)) return "stub-copy";
  return undefined;
}

function h1Title(content: string): string | undefined {
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1]!.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() : undefined;
}

interface DocPair {
  a: string;
  b: string;
  title: string;
}

function findDuplicateDocPairs(files: Map<string, string>): DocPair[] {
  const byTitle = new Map<string, string[]>();
  for (const [path, content] of files) {
    if (extname(path) !== ".md" || !path.trim()) continue;
    const title = h1Title(content);
    if (!title) continue;
    const arr = byTitle.get(title) ?? [];
    arr.push(path);
    byTitle.set(title, arr);
  }
  const pairs: DocPair[] = [];
  for (const [title, paths] of byTitle) {
    if (paths.length < 2) continue;
    for (let i = 1; i < paths.length; i++) pairs.push({ a: paths[0]!, b: paths[i]!, title });
  }
  return pairs;
}

// --- scan --------------------------------------------------------------

const MAX_READ_BYTES = 1_000_000;

function readTrackedFiles(ctx: HandlerContext, dir: string): { files: string[]; error?: string } {
  const r = ctx.runCommand("git", ["-C", dir, "ls-files"], { timeoutMs: 15_000 });
  if (r.status !== 0 || r.error) return { files: [], error: r.stderr || r.error || "git ls-files failed" };
  return { files: r.stdout.split("\n").filter((s) => s.trim() !== "") };
}

function readAll(dir: string, paths: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of paths) {
    try {
      const buf = readFileSync(join(dir, p));
      if (buf.byteLength > MAX_READ_BYTES || buf.includes(0)) continue; // skip large/binary files
      out.set(p, buf.toString("utf8"));
    } catch {
      // unreadable (permissions, race) — skip rather than crash the scan
    }
  }
  return out;
}

function scanProject(ctx: HandlerContext, dir: string): { findings: Finding[]; error?: string } {
  const tracked = readTrackedFiles(ctx, dir);
  if (tracked.error) return { findings: [], error: tracked.error };
  const files = readAll(dir, tracked.files);
  const dupPairs = findDuplicateDocPairs(files);

  const findings: Finding[] = [];
  for (const path of tracked.files) {
    if (isAppendOnly(path)) {
      findings.push({ path, verdict: "keep", confidence: "high", pin: "append-only-record", evidence: "matches the append-only audit record allowlist — always exempt" });
      continue;
    }
    if (isEcosystemPin(path)) {
      findings.push({ path, verdict: "keep", confidence: "high", pin: "ecosystem-convention", evidence: "matches an ecosystem path convention (CI, Homebrew Formula, or a root agent/doc file)" });
      continue;
    }
    const content = files.get(path);
    if (content === undefined) {
      findings.push({ path, verdict: "keep", confidence: "low", pin: "unreadable", evidence: "file could not be read (binary, too large, or a race) — skipped rather than guessed at" });
      continue;
    }

    const pin = findPin(path, files);
    if (pin?.confidence === "high") {
      findings.push({ path, verdict: "keep", confidence: "high", pin: pin.kind, evidence: `referenced elsewhere via ${pin.kind}` });
      continue;
    }

    const dup = dupPairs.find((p) => p.a === path || p.b === path);
    if (dup) {
      const other = dup.a === path ? dup.b : dup.a;
      findings.push({
        path,
        verdict: "merge",
        confidence: pin ? "low" : "high",
        rotClass: "duplicate-doc-pair",
        pin: pin?.kind,
        pairWith: other,
        evidence: `shares a normalized H1 title ("${dup.title}") with ${other} — name which absorbs which before merging`,
      });
      continue;
    }

    if (pin?.confidence === "low") {
      findings.push({
        path,
        verdict: "review",
        confidence: "low",
        rotClass: classify(path, content),
        pin: pin.kind,
        evidence: `no structural reference found, but a ${pin.kind} was seen elsewhere — this is one of the two pin classes that can't be fully verified by static grep; needs human confirmation before any delete`,
      });
      continue;
    }

    const rotClass = classify(path, content);
    if (rotClass) {
      findings.push({ path, verdict: "delete", confidence: "high", rotClass, evidence: `unreferenced tracked file classified as ${rotClass}` });
      continue;
    }
    findings.push({ path, verdict: "review", confidence: "low", evidence: "unreferenced tracked file did not match a specific rot-taxonomy pattern — needs manual classification before any action" });
  }

  return { findings };
}

// --- plan --------------------------------------------------------------

// Deterministic JSON (recursively sorted keys), the same shape disk-maintenance.ts
// uses for its planHash — a small local copy per domain, not a shared import.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const body = keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",");
  return `{${body}}`;
}

function buildTiers(findings: Finding[]): { tier1: Finding[]; tier2: Finding[]; needsReview: Finding[] } {
  const tier1 = findings.filter((f) => f.verdict === "delete" && f.confidence === "high");
  const tier2 = findings.filter((f) => f.verdict === "merge" && f.confidence === "high");
  const needsReview = findings.filter((f) => f.confidence === "low" || f.verdict === "review");
  return { tier1, tier2, needsReview };
}

// A content hash of the exact batch a downstream handoff step would act on —
// same shape as disk-maintenance.ts's computePlanHash: recompute-and-compare,
// never trust a caller-supplied plan blindly.
function computePlanHash(tier1: Finding[], tier2: Finding[]): string {
  const canon = {
    tier1: tier1.map((f) => ({ path: f.path, rotClass: f.rotClass })).sort((a, b) => a.path.localeCompare(b.path)),
    tier2: tier2.map((f) => ({ path: f.path, pairWith: f.pairWith })).sort((a, b) => a.path.localeCompare(b.path)),
  };
  return `sha256:${createHash("sha256").update(stableStringify(canon)).digest("hex")}`;
}

// --- handler --------------------------------------------------------------

function handler(input: Record<string, unknown>, ctx: HandlerContext): ToolResultPayload {
  const action = String(input.action ?? "");
  if (action !== "scan" && action !== "plan" && action !== "rules") return { ok: false, action, error: "action must be scan, plan, or rules" };

  if (action === "rules") return { ok: true, action, snippet: RULES_SNIPPET };

  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return { ok: false, action, error: "name is required" };
  const project = findProject(name, loadProjects(ctx.home));
  if (!project) return { ok: false, action, name, error: `unknown project: ${name}` };
  const dir = projectPath(project, ctx.home);
  if (!insideHome(dir, ctx.home)) return { ok: false, action, name, error: "project path outside home" };
  if (!existsSync(dir)) return { ok: false, action, name, error: "path not found" };

  const scanned = scanProject(ctx, dir);
  if (scanned.error) return { ok: false, action, name, error: scanned.error };

  if (action === "scan") {
    return { ok: true, action, name, findings: scanned.findings, notImplemented: NOT_IMPLEMENTED, arbiter: ARBITER_NOTE };
  }

  const { tier1, tier2, needsReview } = buildTiers(scanned.findings);
  const planHash = computePlanHash(tier1, tier2);
  return {
    ok: true,
    action,
    name,
    tiers: {
      tier1DeleteZeroConsumer: tier1,
      tier2MergeDuplicates: tier2,
      tier3FixStaleFacts: [],
      tier4HistoryPurge: [],
    },
    needsReview,
    notImplemented: NOT_IMPLEMENTED,
    planHash,
    arbiter: ARBITER_NOTE,
  };
}

export const repoSlim: Capability = {
  name: "repo_slim",
  description:
    "Read-only repo slim-down audit for one project (by name from ~/.chime/projects.json). action=scan walks the project's git-tracked files and classifies each one KEEP (with a pin reason — ecosystem convention, append-only record, import, spawn/exec, CI workflow step, package.json field, or doc link) or a rot-taxonomy candidate (delete: orphan tooling / superseded draft / version-era snapshot / stub-copy; merge: duplicate-doc-pair) with an evidence trail and a confidence. Two pin classes can't be fully verified by static grep (a content pin like readFileSync on the file; a runtime path convention) — files with only a soft signal for one of those come back verdict:review, confidence:low, never a blind delete. action=plan groups scan's high-confidence findings into risk tiers (tier1 delete-zero-consumer, tier2 merge-duplicates; tier3 stale-facts and tier4 history-purge are not implemented yet and are always empty) and returns a planHash over the exact batch. action=rules needs no project — it returns a ready-to-commit markdown snippet of the four File Lifecycle rules (anti-regrowth) plus the append-only exemption, for pasting into the target repo's agent rules file. This tool never writes to the target project — its only output is the report. The target repo's own full test suite against the committed head is the final arbiter, not this scan.",
  inputSchema,
  handler,
};
