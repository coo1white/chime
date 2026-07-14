import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Capability, HandlerContext, JsonSchema, ToolResultPayload } from "../types.ts";
import { findProject, loadProjects, projectPath } from "../projects.ts";
import { buildLedgerProposal, type LedgerProposal } from "../ledger.ts";

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
type RotClass = "orphan-tooling" | "superseded-draft" | "version-era-snapshot" | "stub-copy" | "duplicate-doc-pair" | "stale-facts";

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
  "stale-facts (rot class 5): only two mechanically checkable claim classes are detected — a dead path reference and a dead tool/command reference, both inside backtick spans, markdown links, or fenced code. Free-form prose claims (an outdated sentence describing behavior) still need semantic comparison and route through a human or LLM review pass.",
];

// Handed to the executor inside every proposal's rationale — the scan is not the
// final word, the target repo's own suite is. tier4 (history purge) is called
// out explicitly even though it's never auto-proposed (plan.tiers.tier4HistoryPurge
// is always empty in v1): a human reading a batch of proposals should not assume
// silence there means "nothing to purge," only "not implemented yet."
const VERIFICATION_CONTRACT =
  "Verification contract: run the target repo's full test suite against the COMMITTED head before merging, not this scan. Rebase, don't merge, on conflicts. One PR per batch — do not combine batches. List-confirm the exact file set against this proposal before any destructive step. History purges (tier4) are never auto-proposed and always need an explicit owner yes.";

const inputSchema: JsonSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["scan", "plan", "rules", "handoff"],
      description:
        "scan is read-only file-by-file classification; plan groups scan's findings into risk tiers and returns a planHash over the exact batch; rules emits a ready-to-commit anti-regrowth rules snippet (no project needed); handoff turns plan's high-confidence tiers into ledger proposals and REQUIRES the exact planHash from a prior plan call",
    },
    name: { type: "string", description: "project name from ~/.chime/projects.json — required for scan, plan, and handoff; unused by rules" },
    planHash: { type: "string", description: "handoff only: REQUIRED — the exact planHash returned by a prior plan call for this same project. Recomputed live from a fresh scan+plan; a mismatch (filesystem changed, or wrong hash) refuses the handoff." },
    dryRun: { type: "boolean", description: "handoff only: default true. true returns the proposals marked draft (for review only); false marks them ready-to-relay. repo_slim never writes or sends anything itself either way — an operator always relays the entries manually." },
    from: { type: "string", description: "handoff only: the authoring agent/repo (default: chime)" },
    to: { type: "string", description: "handoff only: the receiving agent/repo (default: cool-workflow)" },
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
// Root-level convention files a toolchain finds by fixed NAME, never by textual
// reference — grep will never find a "pin" for these, so without this allowlist
// they'd land in the low-confidence review bucket every single run. Found by
// running scan against chime's own repo: package.json/.gitignore/lockfiles came
// back "review" purely because nothing ever spells their own filename out loud.
const ROOT_CONFIG_NAMES = /^(package(-lock)?\.json|\.gitignore|\.npmignore|\.editorconfig|tsconfig(\..+)?\.json)$/i;
// A file the test runner finds by glob/naming convention (node:test, Jest,
// Vitest, ...), never by import — the other real gap the chime self-scan
// surfaced: every *.test.ts in this repo is a real entry point, not dead code.
const TEST_ENTRY_POINT_RE = /\.(test|spec)\.[cm]?[jt]sx?$/i;
const ECOSYSTEM_PATH_PATTERNS: RegExp[] = [/^\.github\//, /^Formula\/.+\.rb$/];
const APPEND_ONLY_PATTERNS: RegExp[] = [/^CHANGELOG(\.[A-Za-z0-9]+)?$/i, /^HISTORY(\.[A-Za-z0-9]+)?$/i, /(^|\/)audit\//i];

// Returns a human-readable reason when `path` matches a known ecosystem
// convention, or undefined when it doesn't — the reason flows straight into the
// finding's evidence field instead of one generic sentence for every case.
function ecosystemPinReason(path: string): string | undefined {
  if (!path.includes("/") && ROOT_DOC_NAMES.test(path)) return "a root agent/doc file (README, LICENSE, AGENTS.md, ...)";
  if (!path.includes("/") && ROOT_CONFIG_NAMES.test(path)) return "a root config/lockfile a toolchain finds by fixed name (package.json, .gitignore, tsconfig.json, ...)";
  if (TEST_ENTRY_POINT_RE.test(path)) return "a test entry point a test runner finds by naming convention, not by import";
  if (ECOSYSTEM_PATH_PATTERNS.some((re) => re.test(path))) return "a CI workflow or Homebrew Formula path convention";
  return undefined;
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

  // baseNoExt may be followed by its own extension in the specifier — this
  // codebase's relative imports spell it out (`from "./repo-slim.ts"`), so the
  // match must not require the closing quote right after the bare basename.
  const importRe = new RegExp(`(?:from\\s+|require\\(|import\\()\\s*["'\`][^"'\`]*${escapeRegExp(baseNoExt)}(?:\\.[A-Za-z0-9]+)?["'\`]`);
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

// --- stale facts (rot class 5, narrowed to two checkable claim classes) ----

// A local, duplicated copy of every registered Capability.name from
// src/tools/index.ts — NOT imported from there, since that file imports THIS
// one (repoSlim is itself a registered capability), so importing it back would
// be circular. Keep this list in lockstep with the registry by hand; the cost
// of drift is small (a brand-new tool name looks "unregistered" for one PR at
// worst) and this finding is capped at review/low regardless.
const KNOWN_TOOL_NAMES = new Set([
  "colima_disk",
  "disk_maintenance",
  "handoff",
  "ledger",
  "memory",
  "project_check",
  "project_doctor",
  "project_health",
  "project_status",
  "projects",
  "repo_slim",
  "self_iteration",
]);

// A command example is only checked when its second token is one of these
// verbs — the `<name> <action>` shape chime's own tools use everywhere. This
// keeps the check narrow: an arbitrary two-word backtick phrase almost never
// matches both an identifier-shaped first word AND one of these exact verbs.
const KNOWN_ACTION_VERBS = new Set(["scan", "plan", "rules", "handoff", "preview", "run", "list", "verify", "propose", "review", "status", "check", "doctor"]);
// Excluded outright even when followed by a KNOWN_ACTION_VERBS-shaped second
// word — "npm run build" is an everyday README line, not a chime tool
// reference, and several of these verbs (run, list, status, check) collide
// with real package-manager/VCS usage. Found by running this against chime's
// own README before this guard existed.
const GENERIC_COMMANDS = new Set(["npm", "npx", "yarn", "pnpm", "bun", "node", "deno", "git", "docker", "make", "cargo", "go", "python", "python3", "pip", "pip3", "brew", "gh", "kubectl", "terraform"]);
const IDENTIFIER_RE = /^[a-z][a-z0-9_]*$/;

function extractBacktickAndFencedSpans(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/`([^`\n]+)`/g)) out.push(m[1]!);
  for (const m of content.matchAll(/```[a-zA-Z]*\n([\s\S]*?)```/g)) {
    for (const line of m[1]!.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

function extractLinkTargets(content: string): string[] {
  return [...content.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!);
}

// A candidate string only "looks like" a repo-relative path claim when it has
// a plausible extension or its directory prefix matches a real tracked
// directory — this is what keeps placeholder prose like `path/to/file` from
// being treated as a claim at all (no extension, and "path/to" isn't a real
// tracked directory).
function looksLikePathClaim(raw: string, trackedDirs: Set<string>): string | undefined {
  // ~/... is a home-directory runtime path (outside the repo entirely, e.g.
  // ~/.chime/projects.json) — never repo-relative, so never checkable against
  // git ls-files. <...> is a template placeholder (~/.chime/memory/<project>.md)
  // — not a literal reference either. Found by running this against chime's own
  // docs: both patterns false-positived as "dead" before this guard existed.
  if (/^https?:/.test(raw) || raw.startsWith("/") || raw.startsWith("#") || raw.startsWith("~") || /[<>]/.test(raw)) return undefined;
  const s = raw.replace(/^\.\//, "").split(/[?#]/)[0]!;
  if (!s.includes("/")) return undefined;
  const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(s);
  const dir = s.split("/").slice(0, -1).join("/");
  if (!hasExt && !trackedDirs.has(dir)) return undefined;
  return s;
}

// Returns the FIRST stale reference found (one finding is enough to route a
// doc to a human), or undefined. Only clearly-structured references are
// checked — backtick spans, fenced code, and markdown links — free-form prose
// stays out of scope, see NOT_IMPLEMENTED.
function findStaleFacts(content: string, trackedFiles: Set<string>, trackedDirs: Set<string>): { evidence: string } | undefined {
  for (const span of extractBacktickAndFencedSpans(content)) {
    const tokens = span.split(/\s+/).filter(Boolean);
    if (tokens.length >= 2 && IDENTIFIER_RE.test(tokens[0]!) && KNOWN_ACTION_VERBS.has(tokens[1]!) && !KNOWN_TOOL_NAMES.has(tokens[0]!) && !GENERIC_COMMANDS.has(tokens[0]!)) {
      return { evidence: `references "${tokens[0]}", which isn't a registered tool name (command shown: \`${span}\`)` };
    }
    const path = looksLikePathClaim(span, trackedDirs);
    if (path && !trackedFiles.has(path)) return { evidence: `references path "${path}" (in \`${span}\`), which isn't in the tracked tree` };
  }
  for (const target of extractLinkTargets(content)) {
    const path = looksLikePathClaim(target, trackedDirs);
    if (path && !trackedFiles.has(path)) return { evidence: `links to "${path}", which isn't in the tracked tree` };
  }
  return undefined;
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

function buildTrackedDirs(paths: string[]): Set<string> {
  const dirs = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return dirs;
}

function scanProject(ctx: HandlerContext, dir: string): { findings: Finding[]; error?: string } {
  const tracked = readTrackedFiles(ctx, dir);
  if (tracked.error) return { findings: [], error: tracked.error };
  const files = readAll(dir, tracked.files);
  const dupPairs = findDuplicateDocPairs(files);
  const trackedFiles = new Set(tracked.files);
  const trackedDirs = buildTrackedDirs(tracked.files);

  const findings: Finding[] = [];
  for (const path of tracked.files) {
    if (isAppendOnly(path)) {
      findings.push({ path, verdict: "keep", confidence: "high", pin: "append-only-record", evidence: "matches the append-only audit record allowlist — always exempt" });
      continue;
    }

    const preEcosystemContent = files.get(path);
    // Stale-facts runs BEFORE the ecosystem/pin chain below, so a "kept" living
    // doc (README, AGENTS.md, ...) still gets checked — those are exactly the
    // docs a stale-facts risk lives in, not orphaned ones.
    if (preEcosystemContent !== undefined && extname(path) === ".md") {
      const stale = findStaleFacts(preEcosystemContent, trackedFiles, trackedDirs);
      if (stale) {
        findings.push({ path, verdict: "review", confidence: "low", rotClass: "stale-facts", evidence: stale.evidence });
        continue;
      }
    }

    const ecosystemReason = ecosystemPinReason(path);
    if (ecosystemReason) {
      findings.push({ path, verdict: "keep", confidence: "high", pin: "ecosystem-convention", evidence: `matches ${ecosystemReason}` });
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

function buildTiers(findings: Finding[]): { tier1: Finding[]; tier2: Finding[]; tier3: Finding[]; needsReview: Finding[] } {
  const tier1 = findings.filter((f) => f.verdict === "delete" && f.confidence === "high");
  const tier2 = findings.filter((f) => f.verdict === "merge" && f.confidence === "high");
  const tier3 = findings.filter((f) => f.rotClass === "stale-facts");
  // Every finding lands in exactly one bucket — tier3 (always confidence:low,
  // verdict:review by construction) would otherwise double up with needsReview.
  const needsReview = findings.filter((f) => (f.confidence === "low" || f.verdict === "review") && f.rotClass !== "stale-facts");
  return { tier1, tier2, tier3, needsReview };
}

// A content hash of the exact batch a downstream handoff step would act on —
// same shape as disk-maintenance.ts's computePlanHash: recompute-and-compare,
// never trust a caller-supplied plan blindly.
function computePlanHash(tier1: Finding[], tier2: Finding[], tier3: Finding[]): string {
  const canon = {
    tier1: tier1.map((f) => ({ path: f.path, rotClass: f.rotClass })).sort((a, b) => a.path.localeCompare(b.path)),
    tier2: tier2.map((f) => ({ path: f.path, pairWith: f.pairWith })).sort((a, b) => a.path.localeCompare(b.path)),
    tier3: tier3.map((f) => ({ path: f.path, evidence: f.evidence })).sort((a, b) => a.path.localeCompare(b.path)),
  };
  return `sha256:${createHash("sha256").update(stableStringify(canon)).digest("hex")}`;
}

// --- handler --------------------------------------------------------------

function handler(input: Record<string, unknown>, ctx: HandlerContext): ToolResultPayload {
  const action = String(input.action ?? "");
  if (action !== "scan" && action !== "plan" && action !== "rules" && action !== "handoff") {
    return { ok: false, action, error: "action must be scan, plan, rules, or handoff" };
  }

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

  // plan and handoff both need the tiers and a live planHash — handoff recomputes
  // this from a FRESH scan every call (never a cached value), same as
  // disk-maintenance.ts's run gate.
  const { tier1, tier2, tier3, needsReview } = buildTiers(scanned.findings);
  const planHash = computePlanHash(tier1, tier2, tier3);

  if (action === "plan") {
    return {
      ok: true,
      action,
      name,
      tiers: {
        tier1DeleteZeroConsumer: tier1,
        tier2MergeDuplicates: tier2,
        tier3FixStaleFacts: tier3,
        tier4HistoryPurge: [],
      },
      needsReview,
      notImplemented: NOT_IMPLEMENTED,
      planHash,
      arbiter: ARBITER_NOTE,
    };
  }

  // action === "handoff" — requires the exact planHash from a prior plan call.
  // Deliberately does not echo the correct hash back on a mismatch: doing so
  // would let a caller "reject once, read the hash off the error, resubmit,"
  // turning the gate into a rubber stamp instead of proof the plan was reviewed.
  const suppliedHash = typeof input.planHash === "string" ? input.planHash : "";
  if (!suppliedHash) {
    return { ok: false, action, name, error: "handoff requires planHash from a prior plan call — call plan first, then pass its planHash to handoff" };
  }
  if (suppliedHash !== planHash) {
    return { ok: false, action, name, error: "planHash does not match the current plan (filesystem changed since plan, or wrong hash supplied) — call plan again for a fresh planHash" };
  }

  const dryRun = input.dryRun !== false; // default true — an explicit false is required to mark proposals ready-to-relay
  const from = String(input.from ?? "").trim() || "chime";
  const to = String(input.to ?? "").trim() || "cool-workflow";
  const createdAt = ctx.now().toISOString();

  const proposals: LedgerProposal[] = [];
  if (tier1.length > 0) {
    proposals.push(
      buildLedgerProposal({
        from,
        to,
        title: `repo_slim: delete ${tier1.length} zero-consumer file(s) in ${name}`,
        rationale: `repo_slim scan found ${tier1.length} tracked file(s) with no import, spawn/exec, CI, doc-link, or package.json reference anywhere in the tree, each classified into a rot-taxonomy delete class. ${VERIFICATION_CONTRACT}`,
        targetFiles: tier1.map((f) => f.path),
        createdAt,
      }),
    );
  }
  if (tier2.length > 0) {
    proposals.push(
      buildLedgerProposal({
        from,
        to,
        title: `repo_slim: merge ${tier2.length} duplicate-doc-pair file(s) in ${name}`,
        rationale: `repo_slim scan found ${tier2.length} markdown file(s) sharing a normalized H1 title with another tracked doc — name which absorbs which before merging. ${VERIFICATION_CONTRACT}`,
        targetFiles: tier2.map((f) => f.path),
        createdAt,
      }),
    );
  }
  if (tier3.length > 0) {
    proposals.push(
      buildLedgerProposal({
        from,
        to,
        title: `repo_slim: fix ${tier3.length} stale-fact reference(s) in ${name}`,
        // Each finding's own evidence names the exact dead reference — worth
        // surfacing per-file here, unlike tier1/tier2, since a fix (not a
        // delete/merge) needs to know WHAT to change, not just where.
        rationale: `repo_slim scan found ${tier3.length} markdown file(s) with a dead path or tool/command reference (backtick span, markdown link, or fenced code block) that no longer resolves in the tracked tree: ${tier3.map((f) => `${f.path} — ${f.evidence}`).join("; ")}. This is a docs fix, not a delete or merge. ${VERIFICATION_CONTRACT}`,
        targetFiles: tier3.map((f) => f.path),
        createdAt,
      }),
    );
  }

  return {
    ok: true,
    action,
    name,
    dryRun,
    status: dryRun
      ? "draft — review before handing to the operator; repo_slim never relays this itself"
      : "ready-to-relay — hand these to the operator for the shared handoff repo; repo_slim never relays this itself",
    proposals,
    note: proposals.length === 0 ? "no tier1/tier2/tier3 batches to propose — nothing to hand off right now" : undefined,
    planHash,
    notImplemented: NOT_IMPLEMENTED,
    arbiter: ARBITER_NOTE,
  };
}

export const repoSlim: Capability = {
  name: "repo_slim",
  description:
    "Read-only repo slim-down audit for one project (by name from ~/.chime/projects.json). action=scan walks the project's git-tracked files and classifies each one KEEP (with a pin reason — ecosystem convention, append-only record, import, spawn/exec, CI workflow step, package.json field, or doc link) or a rot-taxonomy candidate (delete: orphan tooling / superseded draft / version-era snapshot / stub-copy; merge: duplicate-doc-pair; review: stale-facts — a markdown file with a dead path reference or a dead tool/command reference in a backtick span, markdown link, or fenced code block) with an evidence trail and a confidence. Two pin classes can't be fully verified by static grep (a content pin like readFileSync on the file; a runtime path convention) — files with only a soft signal for one of those come back verdict:review, confidence:low, never a blind delete. Stale-facts is likewise narrow: only structured dead references are caught, free-form prose claims still need a human or LLM pass. action=plan groups scan's high-confidence findings into risk tiers (tier1 delete-zero-consumer, tier2 merge-duplicates, tier3 fix-stale-facts; tier4 history-purge is not implemented and always empty) and returns a planHash over the exact batch. action=rules needs no project — it returns a ready-to-commit markdown snippet of the four File Lifecycle rules (anti-regrowth) plus the append-only exemption, for pasting into the target repo's agent rules file. action=handoff turns plan's tier1/tier2/tier3 batches into ledger propose entries (reusing the existing ledger tool's format), one proposal per non-empty tier — it REQUIRES the exact planHash from a prior plan call for this same project and refuses on any mismatch; dryRun (default true) marks proposals draft vs ready-to-relay, but repo_slim never sends or relays anything itself either way — an operator always does that by hand. This tool never writes to the target project — its only output is the report. The target repo's own full test suite against the committed head is the final arbiter, not this scan.",
  inputSchema,
  handler,
};
