import { existsSync, rmSync, readdirSync, statSync, lstatSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type { Capability, HandlerContext, JsonSchema, ToolResultPayload } from "../types.ts";
import { colimaDisk } from "./colima-disk.ts";

type Task = "all" | "clean-dev-cache" | "compress-cold-files";

interface Candidate {
  kind: string;
  path: string;
  sizeMb: number;
  reason: string;
  action: string;
  impact: string;
}

interface Skipped {
  path: string;
  reason: string;
}

const MB = 1024 * 1024;
const DEFAULT_MIN_AGE_DAYS = 30;
const DEFAULT_MIN_SIZE_MB = 100;
const BUILD_DIRS = new Set(["target", ".next", "dist", "build", "node_modules"]);
const TEXT_EXTS = new Set([".log", ".jsonl", ".ndjson", ".sql", ".dump", ".bak", ".txt", ".csv", ".tsv", ".xml"]);
const SKIP_EXTS = new Set([".zip", ".gz", ".tgz", ".zst", ".br", ".xz", ".7z", ".rar", ".dmg", ".pkg", ".mp4", ".mov", ".mp3", ".jpg", ".png", ".pdf", ".sqlite", ".db"]);

const DEV_CACHE_DIRS = [
  ".npm",
  join("Library", "pnpm"),
  join("Library", "Caches", "pnpm"),
  join("Library", "Caches", "pip"),
  join("Library", "Caches", "bun"),
  join("Library", "Caches", "Homebrew"),
];

const CACHE_COMMANDS = [
  { cmd: "npm", args: ["cache", "clean", "--force"], label: "npm cache clean --force" },
  { cmd: "pnpm", args: ["store", "prune"], label: "pnpm store prune" },
  { cmd: "pip", args: ["cache", "purge"], label: "pip cache purge" },
  { cmd: "bun", args: ["pm", "cache", "rm"], label: "bun pm cache rm" },
  { cmd: "brew", args: ["cleanup"], label: "brew cleanup" },
];

const inputSchema: JsonSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["scan", "preview", "run"], description: "scan is read-only; preview is a dry-run plan; run performs allowlisted cleanup/compression" },
    task: { type: "string", enum: ["all", "clean-dev-cache", "compress-cold-files"], description: "which maintenance task to run (default all)" },
    includeProjectBuilds: { type: "boolean", description: "allow deleting old build dirs under ~/Developer (default false)" },
    minAgeDays: { type: "number", description: "minimum age for cold files/build dirs (default 30)" },
    minSizeMb: { type: "number", description: "minimum size for cold-file compression candidates (default 100)" },
    roots: { type: "array", items: { type: "string" }, description: "compression scan roots under the user's home" },
    planHash: { type: "string", description: "REQUIRED for action:run. The exact planHash returned by a preview or scan call made with the same task/includeProjectBuilds/minAgeDays/minSizeMb/roots. Proves the caller reviewed the real candidate list before anything is deleted. If the filesystem changed since that preview, the hash will not match and run is refused — call preview again for a fresh planHash." },
  },
  required: ["action"],
  additionalProperties: false,
};

function underHome(home: string, path: string): boolean {
  const h = resolve(home);
  const p = resolve(path);
  return p === h || p.startsWith(h + sep);
}

function expandRoot(home: string, raw: string): string {
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return join(home, raw.slice(2));
  return isAbsolute(raw) ? raw : join(home, raw);
}

// lstat (not stat) so a symlink is reported as itself, never followed. Every place
// this tool walks a directory or is handed a candidate path must check this first —
// underHome()/hasDangerSegment() only validate the caller-supplied root strings, so a
// symlink discovered mid-recursion is the one way a path can be lexically "under
// home" while resolving somewhere else entirely.
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function sizeBytes(path: string): number {
  if (isSymlink(path)) return 0;
  const s = statSync(path);
  if (!s.isDirectory()) return s.size;
  let total = 0;
  for (const e of readdirSync(path, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    total += sizeBytes(join(path, e.name));
  }
  return total;
}

function safeSizeMb(path: string): number {
  try {
    return Math.round(sizeBytes(path) / MB);
  } catch {
    return 0;
  }
}

// A directory's own mtime only changes when a direct child is added/removed/renamed
// (POSIX semantics) — writing into a file deep inside does not bump it. So staleness
// for a build dir must be judged by the newest mtime found anywhere inside it, not
// the directory's own, or an actively-used node_modules/dist can look stale and get
// deleted. Mirrors sizeBytes()'s recursion shape; skips symlinks the same way.
function newestMtimeMs(path: string): number {
  try {
    if (isSymlink(path)) return 0;
    const s = statSync(path);
    if (!s.isDirectory()) return s.mtimeMs;
    let newest = s.mtimeMs;
    for (const e of readdirSync(path)) newest = Math.max(newest, newestMtimeMs(join(path, e)));
    return newest;
  } catch {
    return 0;
  }
}

// Any dotfile/dot-directory segment is protected (.ssh, .aws, .config, .docker,
// .kube, .gnupg, .git, .colima, .env*, ...) — one general rule instead of an
// enumerated list that inevitably misses something. `.app` check is case-insensitive
// since macOS treats Foo.app/Foo.APP as the same bundle for Finder/LaunchServices.
function hasDangerSegment(path: string): boolean {
  const parts = resolve(path).split(sep);
  return parts.includes("Library") || parts.some((p) => p.startsWith(".")) || parts.some((p) => p.toLowerCase().endsWith(".app"));
}

function defaultRoots(home: string): string[] {
  return ["Downloads", "Desktop", "Documents", join("Developer", "ops", "gitea-backups")].map((p) => join(home, p));
}

function wantedTask(input: Record<string, unknown>): Task {
  const t = input.task;
  return t === "clean-dev-cache" || t === "compress-cold-files" || t === "all" ? t : "all";
}

function minNumber(input: Record<string, unknown>, key: string, fallback: number): number {
  const n = Number(input[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function cacheCandidates(home: string, now: Date, minAgeDays: number, includeProjectBuilds: boolean, skipped: Skipped[]): Candidate[] {
  const out: Candidate[] = [];
  for (const rel of DEV_CACHE_DIRS) {
    const path = join(home, rel);
    if (!existsSync(path)) {
      skipped.push({ path, reason: "missing" });
      continue;
    }
    const sizeMb = safeSizeMb(path);
    if (sizeMb > 0) {
      out.push({ kind: "dev-cache", path, sizeMb, reason: "regenerable developer cache", action: "clean via package-manager cleanup", impact: "reclaims space; later installs may redownload packages" });
    }
  }

  const colima = join(home, ".colima");
  if (existsSync(colima)) {
    const sizeMb = safeSizeMb(colima);
    if (sizeMb > 0) out.push({ kind: "dev-cache", path: colima, sizeMb, reason: "Colima/Docker VM disk", action: "delegate to colima_disk", impact: "safe Colima reclaim path" });
  }

  const dev = join(home, "Developer");
  if (!existsSync(dev)) return out;
  for (const project of readdirSync(dev)) {
    const base = join(dev, project);
    try {
      if (isSymlink(base) || !statSync(base).isDirectory()) continue;
      for (const name of readdirSync(base)) {
        if (!BUILD_DIRS.has(name)) continue;
        const path = join(base, name);
        if (isSymlink(path)) {
          skipped.push({ path, reason: "symlink (not followed)" });
          continue;
        }
        const days = Math.floor((now.getTime() - newestMtimeMs(path)) / 86_400_000);
        const sizeMb = safeSizeMb(path);
        if (days < minAgeDays || sizeMb <= 0) continue;
        const action = includeProjectBuilds ? "delete old project build output" : "report only (set includeProjectBuilds to delete)";
        out.push({ kind: "project-build", path, sizeMb, reason: `${days} days old build artifact`, action, impact: "rebuild may take longer next time" });
      }
    } catch {
      skipped.push({ path: base, reason: "cannot inspect project" });
    }
  }
  return out;
}

function coldCandidates(roots: string[], home: string, now: Date, minAgeDays: number, minSizeMb: number, skipped: Skipped[]): Candidate[] {
  const out: Candidate[] = [];
  const walk = (path: string): void => {
    if (!underHome(home, path)) {
      skipped.push({ path, reason: "outside home" });
      return;
    }
    if (hasDangerSegment(path)) {
      skipped.push({ path, reason: "protected path" });
      return;
    }
    if (isSymlink(path)) {
      skipped.push({ path, reason: "symlink (not followed)" });
      return;
    }
    let s;
    try {
      s = statSync(path);
    } catch {
      skipped.push({ path, reason: "missing" });
      return;
    }
    if (s.isDirectory()) {
      for (const e of readdirSync(path)) walk(join(path, e));
      return;
    }
    const ext = extname(path).toLowerCase();
    if (!TEXT_EXTS.has(ext)) {
      if (SKIP_EXTS.has(ext)) skipped.push({ path, reason: "already compressed/media/db" });
      return;
    }
    const days = Math.floor((now.getTime() - s.mtimeMs) / 86_400_000);
    const sizeMb = Math.round(s.size / MB);
    if (days < minAgeDays || sizeMb < minSizeMb) return;
    const archive = `${path}.tar.gz`;
    if (existsSync(archive)) {
      skipped.push({ path, reason: "archive already exists" });
      return;
    }
    out.push({ kind: "cold-file", path, sizeMb, reason: `${days} days old ${ext} file`, action: `tar -czf ${archive}`, impact: "verified archive, then delete original" });
  };
  for (const root of roots) walk(root);
  return out;
}

function normalizedRoots(input: Record<string, unknown>, home: string): { roots: string[]; error?: string } {
  const raw = Array.isArray(input.roots) ? input.roots.map(String) : defaultRoots(home);
  const roots = raw.map((r) => resolve(expandRoot(home, r)));
  // Reject the bare home directory itself as a root — the single broadest,
  // most-surprising invocation (roots:["~"]) — while still allowing any named
  // subdirectory under home (roots stays a documented, user-selectable feature).
  const bad = roots.find((r) => !underHome(home, r) || r === resolve(home));
  return bad ? { roots, error: `root not permitted: ${bad}` } : { roots };
}

function available(ctx: HandlerContext, cmd: string): boolean {
  const r = ctx.runCommand("which", [cmd], { timeoutMs: 10_000 });
  return r.status === 0;
}

function deletePath(path: string): string | undefined {
  try {
    rmSync(path, { recursive: true, force: true });
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function compress(ctx: HandlerContext, path: string): string | undefined {
  const archive = `${path}.tar.gz`;
  const tar = ctx.runCommand("tar", ["-czf", archive, "-C", dirname(path), basename(path)], { timeoutMs: 180_000 });
  if (tar.status !== 0 || tar.error) return tar.stderr || tar.error || "tar failed";
  const verify = ctx.runCommand("tar", ["-tzf", archive], { timeoutMs: 60_000 });
  if (verify.status !== 0 || verify.error) return verify.stderr || verify.error || "archive verification failed";
  return deletePath(path);
}

function commandStrings(): string[] {
  return CACHE_COMMANDS.map((c) => c.label);
}

// Deterministic JSON (recursively sorted keys) so the hash is a function of content
// only. Deliberately a small LOCAL copy of the same pattern ledger.ts uses for its
// content-addressed digest — not imported from there, since a disk-maintenance plan
// is a different domain from a cross-repo ledger entry and shouldn't drag in its
// from/to/schemaVersion fields.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const body = keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",");
  return `{${body}}`;
}

interface Plan {
  task: Task;
  includeProjectBuilds: boolean;
  minAgeDays: number;
  minSizeMb: number;
  roots: string[];
  candidates: Candidate[];
}

// A content hash of exactly what run is about to do. preview/scan return it; run
// recomputes it fresh (from a LIVE rescan, not a cached value) and requires an exact
// match before touching anything — this is what turns "call preview first" from a
// suggestion into something the caller structurally cannot skip: a hash of the real
// candidate set cannot be produced without the enumeration having actually happened.
function computePlanHash(plan: Plan): string {
  const canon = {
    task: plan.task,
    includeProjectBuilds: plan.includeProjectBuilds,
    minAgeDays: plan.minAgeDays,
    minSizeMb: plan.minSizeMb,
    roots: [...plan.roots].sort(),
    candidates: plan.candidates.map((c) => ({ kind: c.kind, path: c.path, sizeMb: c.sizeMb })),
  };
  return `sha256:${createHash("sha256").update(stableStringify(canon)).digest("hex")}`;
}

function handler(input: Record<string, unknown>, ctx: HandlerContext): ToolResultPayload {
  const action = String(input.action ?? "");
  if (!["scan", "preview", "run"].includes(action)) return { ok: false, action, error: "action must be scan, preview, or run" };

  const task = wantedTask(input);
  const minAgeDays = minNumber(input, "minAgeDays", DEFAULT_MIN_AGE_DAYS);
  const minSizeMb = minNumber(input, "minSizeMb", DEFAULT_MIN_SIZE_MB);
  const includeProjectBuilds = input.includeProjectBuilds === true;
  const nr = normalizedRoots(input, ctx.home);
  if (nr.error) return { ok: false, action, dryRun: action !== "run", scannedRoots: nr.roots, candidates: [], skipped: [], plannedReclaimMb: 0, error: nr.error };

  const skipped: Skipped[] = [];
  const candidates = [
    ...(task === "all" || task === "clean-dev-cache" ? cacheCandidates(ctx.home, ctx.now(), minAgeDays, includeProjectBuilds, skipped) : []),
    ...(task === "all" || task === "compress-cold-files" ? coldCandidates(nr.roots, ctx.home, ctx.now(), minAgeDays, minSizeMb, skipped) : []),
  ];
  const plannedReclaimMb = candidates.reduce((sum, c) => sum + c.sizeMb, 0);
  const commands = [...(task === "all" || task === "clean-dev-cache" ? commandStrings() : []), ...candidates.filter((c) => c.kind === "cold-file").map((c) => c.action)];
  const planHash = computePlanHash({ task, includeProjectBuilds, minAgeDays, minSizeMb, roots: nr.roots, candidates });

  if (action !== "run") {
    return { ok: true, action, dryRun: action === "preview", scannedRoots: nr.roots, candidates, skipped, plannedReclaimMb, commands, planHash };
  }

  // run requires the exact planHash from a prior preview/scan of this same plan.
  // Recomputed above from a LIVE rescan (not a cached value), so a mismatch means
  // either no preview ever happened, or the filesystem/params drifted since it did —
  // either way, fail closed and make the caller preview again rather than silently
  // acting on a plan nobody actually reviewed. Deliberately do not echo the live hash
  // back here: doing so would let a caller "reject once, read the correct hash off
  // the error, resubmit," turning the gate into a rubber stamp.
  const suppliedHash = typeof input.planHash === "string" ? input.planHash : "";
  if (!suppliedHash) {
    return { ok: false, action, dryRun: false, scannedRoots: nr.roots, candidates: [], skipped: [], plannedReclaimMb: 0, error: "run requires planHash from a prior preview or scan call — call preview first, then pass its planHash to run" };
  }
  if (suppliedHash !== planHash) {
    return { ok: false, action, dryRun: false, scannedRoots: nr.roots, candidates: [], skipped: [], plannedReclaimMb: 0, error: "planHash does not match the current candidate set (filesystem or params changed since preview, or wrong hash supplied) — call preview again for a fresh planHash" };
  }

  const errors: string[] = [];
  let reclaimedMb = 0;
  if (task === "all" || task === "clean-dev-cache") {
    const colima = colimaDisk.handler({ action: "run" }, ctx);
    if (colima instanceof Promise) errors.push("colima cleanup returned async unexpectedly");
    else if (!colima.ok) errors.push(`colima_disk: ${String(colima.error ?? colima.summaryLine ?? "failed")}`);

    for (const c of CACHE_COMMANDS) {
      if (!available(ctx, c.cmd)) {
        skipped.push({ path: c.cmd, reason: "command not found" });
        continue;
      }
      const r = ctx.runCommand(c.cmd, c.args, { timeoutMs: 180_000 });
      if (r.status !== 0 || r.error) errors.push(`${c.label}: ${r.stderr || r.error || "failed"}`);
    }

    if (includeProjectBuilds) {
      for (const c of candidates.filter((x) => x.kind === "project-build")) {
        const err = deletePath(c.path);
        if (err) errors.push(`${c.path}: ${err}`);
        else reclaimedMb += c.sizeMb;
      }
    }
  }

  if (task === "all" || task === "compress-cold-files") {
    for (const c of candidates.filter((x) => x.kind === "cold-file")) {
      const err = compress(ctx, c.path);
      if (err) errors.push(`${c.path}: ${err}`);
      else reclaimedMb += c.sizeMb;
    }
  }

  return { ok: errors.length === 0, action, dryRun: false, scannedRoots: nr.roots, candidates, skipped, plannedReclaimMb, reclaimedMb, commands, errors, planHash };
}

export const diskMaintenance: Capability = {
  name: "disk_maintenance",
  description:
    "Safely scan, preview, or run disk maintenance on macOS. It targets regenerate-safe developer caches, delegates Colima cleanup to colima_disk, and compresses only old text-like cold files under user-selected home-directory roots. scan is read-only; preview plans exact actions and returns a planHash; run performs only allowlisted cleanup and verified tar.gz archives, and REQUIRES the planHash from a prior preview or scan call made with identical parameters — call preview first, show the user the exact candidates, then call run with that exact planHash. If anything changed on disk since the preview (or the params differ), run is refused and you must preview again.",
  inputSchema,
  handler,
};
