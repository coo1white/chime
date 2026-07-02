import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Capability, CommandResult, HandlerContext, JsonSchema, ToolResultPayload } from "../types.ts";

// Chime never reimplements the maintenance logic — it shells out to the existing
// colima-disk-maintenance script and reads its log. The .sh stays the source of truth.

function scriptPath(home: string): string {
  const symlink = join(home, ".local", "bin", "colima-disk-maintenance");
  const direct = join(home, "Developer", "colima-disk-maintenance", "bin", "colima-disk-maintenance.sh");
  if (existsSync(symlink)) return symlink;
  if (existsSync(direct)) return direct;
  return symlink;
}

function logPath(home: string): string {
  return join(home, "Library", "Logs", "colima-disk-maintenance.log");
}

function lastNonEmpty(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]!.trim();
    if (t) return t;
  }
  return "";
}

// Best-effort: classify the run/log outcome from the script's leading log tokens.
// Always paired with the raw summaryLine/logTail so a format drift degrades to
// "less structured", never "wrong".
function classify(text: string): string {
  if (/reclaimed:/.test(text)) return "reclaimed";
  if (/\bact:/.test(text)) return "act";
  if (/\bskip:/.test(text)) return "skip";
  if (/\[dry-run\]/.test(text)) return "dry-run";
  return "unknown";
}

function scrape(text: string): { freeGb?: number; colimaGb?: number } {
  const out: { freeGb?: number; colimaGb?: number } = {};
  const f = text.match(/free (\d+)GB/);
  const c = text.match(/\.colima (\d+)GB/);
  if (f) out.freeGb = Number(f[1]);
  if (c) out.colimaGb = Number(c[1]);
  return out;
}

const inputSchema: JsonSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["run", "preview", "status", "compact_preview", "compact_run"],
      description:
        "run = light reclaim now (safe: dangling images + fstrim); preview = light dry-run; status = read the latest log; compact_preview = read-only deep compaction plan; compact_run = confirmed deep compaction",
    },
    freeMinGb: { type: "number", description: "override CW_FREE_MIN_GB (the free-space trigger, GB)" },
    colimaMaxGb: { type: "number", description: "override CW_COLIMA_MAX_GB (the .colima-size trigger, GB)" },
    confirm: { type: "boolean", description: "compact_run only: must be true before mutating Colima/Docker state" },
    targetGb: { type: "number", description: "compact_run/compact_preview: desired datadisk physical size in GB (default 10)" },
    planHash: { type: "string", description: "compact_run only: REQUIRED. The exact planHash returned by a prior compact_preview call made with the same targetGb. compact_run recomputes it live and refuses if it does not match — call compact_preview again for a fresh planHash if the datadisk size changed or none was ever obtained." },
    logLines: { type: "number", description: "status only: how many recent log lines to read (default 10)" },
  },
  required: ["action"],
  additionalProperties: false,
};

function datadiskPath(home: string): string {
  return join(home, ".colima", "_lima", "_disks", "colima", "datadisk");
}

function dockerHost(home: string): string {
  return `unix://${join(home, ".colima", "default", "docker.sock")}`;
}

function compactBackupDir(home: string, stamp: string): string {
  return join(home, ".chime", "colima-compact", stamp);
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

function targetGb(input: Record<string, unknown>): number {
  const n = Number(input.targetGb);
  return Number.isFinite(n) && n > 0 ? n : 10;
}

// Deterministic JSON (recursively sorted keys) so the hash is a function of content
// only. Local copy of the same pattern disk-maintenance.ts / ledger.ts use — not
// imported, since a colima compaction plan is a different domain from either.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const body = keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",");
  return `{${body}}`;
}

// A content hash of exactly what compact_run is about to act on: the target size
// and the datadisk size compact_preview actually observed. compact_preview returns
// this; compact_run requires it verbatim (recomputed from ITS OWN live "datadisk du"
// read, not a cached value) before doing anything destructive. Deliberately narrow —
// excludes colima status / df / raw qemu-img info / docker system df,ps,image ls,
// volume ls, since those are either purely informational or inherently volatile for
// reasons unrelated to whether this plan is still the one that was previewed.
function computeCompactPlanHash(plan: { targetGb: number; currentDatadiskGb: number | undefined }): string {
  return `sha256:${createHash("sha256").update(stableStringify(plan)).digest("hex")}`;
}

function run(
  ctx: HandlerContext,
  label: string,
  cmd: string,
  args: string[],
  timeoutMs = 300_000,
  env?: Record<string, string | undefined>,
): { label: string; cmd: string; args: string[]; result: CommandResult } {
  return { label, cmd, args, result: ctx.runCommand(cmd, args, { timeoutMs, env }) };
}

function okStep(step: { result: CommandResult }): boolean {
  return step.result.status === 0 && !step.result.error;
}

function output(step: { result: CommandResult }): string {
  return `${step.result.stdout}\n${step.result.stderr}`.trim();
}

function parseFirstSizeGb(text: string): number | undefined {
  const m = text.match(/([\d.]+)\s*([KMGT])i?B?/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = m[2]!.toUpperCase();
  if (unit === "K") return n / 1024 / 1024;
  if (unit === "M") return n / 1024;
  if (unit === "G") return n;
  if (unit === "T") return n * 1024;
  return undefined;
}

function parseMarkedSizeGb(text: string, marker: string): number | undefined {
  const line = text.split("\n").find((l) => l.includes(marker));
  return line ? parseFirstSizeGb(line) : undefined;
}

function parseMarkerRc(text: string, marker: string): number | undefined {
  const m = text.match(new RegExp(`${marker}=(\\d+)`));
  return m ? Number(m[1]) : undefined;
}

function compactPlan(): string[] {
  return [
    "save Docker container/image/volume/system-df manifests under ~/.chime/colima-compact/<timestamp>",
    "delete regenerable Docker build cache with docker builder prune -af",
    "delete unused images with docker image prune -af; keep volumes and images used by running containers",
    "zero-fill free space inside /var/lib/docker, then remove the temporary file",
    "stop Colima and qemu-img convert the raw datadisk into a sparse compacted file",
    "swap the compacted datadisk into place while retaining the old disk as a rollback file",
    "start Colima, verify Docker/containers/volumes/datadisk size, then delete rollback only on success",
  ];
}

function compactPreview(input: Record<string, unknown>, ctx: HandlerContext): ToolResultPayload {
  const disk = datadiskPath(ctx.home);
  const target = targetGb(input);
  const host = dockerHost(ctx.home);
  if (!existsSync(disk)) {
    return {
      ok: true,
      action: "compact_preview",
      applicable: false,
      targetGb: target,
      datadisk: disk,
      error: "Colima raw datadisk not found; this deep compaction path only supports macOS Colima raw datadisk",
    };
  }

  const steps = [
    run(ctx, "which colima", "which", ["colima"], 10_000),
    run(ctx, "which docker", "which", ["docker"], 10_000),
    run(ctx, "which qemu-img", "which", ["qemu-img"], 10_000),
    run(ctx, "colima status", "colima", ["status"], 30_000),
    run(ctx, "data volume df", "df", ["-h", "/System/Volumes/Data"], 10_000),
    run(ctx, "datadisk du", "du", ["-h", disk], 30_000),
    run(ctx, "datadisk qemu-img info", "qemu-img", ["info", disk], 30_000),
    run(ctx, "docker system df", "docker", ["system", "df"], 30_000, { DOCKER_HOST: host }),
    run(ctx, "docker ps -a", "docker", ["ps", "-a"], 30_000, { DOCKER_HOST: host }),
    run(ctx, "docker image ls", "docker", ["image", "ls", "--digests"], 30_000, { DOCKER_HOST: host }),
    run(ctx, "docker volume ls", "docker", ["volume", "ls"], 30_000, { DOCKER_HOST: host }),
  ];
  const missing = steps.slice(0, 3).filter((s) => !okStep(s)).map((s) => s.label.replace("which ", ""));
  const currentDatadiskGb = parseFirstSizeGb(steps.find((s) => s.label === "datadisk du")?.result.stdout ?? "");
  const planHash = computeCompactPlanHash({ targetGb: target, currentDatadiskGb });
  return {
    ok: missing.length === 0,
    action: "compact_preview",
    applicable: missing.length === 0,
    targetGb: target,
    datadisk: disk,
    dockerHost: host,
    currentDatadiskGb,
    planHash,
    needsDeepCompact: currentDatadiskGb === undefined ? undefined : currentDatadiskGb > target,
    preserves: ["running containers", "images used by running containers", "Docker volumes"],
    removes: ["Docker build cache", "unused Docker images"],
    plannedSteps: compactPlan(),
    checks: steps.map((s) => ({ label: s.label, ok: okStep(s), exitCode: s.result.status, stdout: s.result.stdout.trim(), stderr: s.result.stderr.trim(), error: s.result.error })),
    error: missing.length > 0 ? `missing required command(s): ${missing.join(", ")}` : undefined,
  };
}

function sh(ctx: HandlerContext, label: string, script: string, timeoutMs = 300_000): { label: string; cmd: string; args: string[]; result: CommandResult } {
  return run(ctx, label, "sh", ["-lc", script], timeoutMs);
}

function fail(action: string, step: { label: string; result: CommandResult }, extra: Record<string, unknown> = {}): ToolResultPayload {
  return {
    ok: false,
    action,
    failedStep: step.label,
    exitCode: step.result.status,
    stdout: step.result.stdout.trim(),
    stderr: step.result.stderr.trim(),
    error: step.result.error || lastNonEmpty((step.result.stderr || step.result.stdout).split("\n")) || `${step.label} failed`,
    ...extra,
  };
}

function compactRun(input: Record<string, unknown>, ctx: HandlerContext): ToolResultPayload {
  const action = "compact_run";
  const disk = datadiskPath(ctx.home);
  const target = targetGb(input);
  if (!existsSync(disk)) {
    return { ok: false, action, targetGb: target, datadisk: disk, error: "Colima raw datadisk not found; nothing changed" };
  }
  if (input.confirm !== true) {
    return { ok: false, action, targetGb: target, datadisk: disk, error: "compact_run mutates Docker/Colima state; call again with confirm: true after compact_preview" };
  }

  // planHash is proof a real compact_preview happened, not just a rubber-stamped
  // boolean: recompute it here from a LIVE "datadisk du" read (not a cached value)
  // and require an exact match before anything destructive runs — same fail-closed,
  // no-partial-match discipline as disk-maintenance.ts's run gate.
  const duCheck = run(ctx, "datadisk du", "du", ["-h", disk], 30_000);
  const currentDatadiskGb = parseFirstSizeGb(duCheck.result.stdout);
  const suppliedHash = typeof input.planHash === "string" ? input.planHash : "";
  const livePlanHash = computeCompactPlanHash({ targetGb: target, currentDatadiskGb });
  if (!suppliedHash) {
    return { ok: false, action, targetGb: target, datadisk: disk, currentDatadiskGb, error: "compact_run requires planHash from a prior compact_preview call — call compact_preview first, then pass its planHash to compact_run" };
  }
  if (suppliedHash !== livePlanHash) {
    return { ok: false, action, targetGb: target, datadisk: disk, currentDatadiskGb, error: "planHash does not match the current datadisk state (size changed since preview, or wrong target/hash supplied) — call compact_preview again for a fresh planHash" };
  }

  const stamp = ctx.now().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const backup = compactBackupDir(ctx.home, stamp);
  const host = dockerHost(ctx.home);
  const compacted = `${disk}.compacted`;
  const rollback = `${disk}.before-final-compact-${stamp}`;
  const steps: Array<{ label: string; cmd: string; args: string[]; result: CommandResult }> = [duCheck];

  const preflight = [
    run(ctx, "which colima", "which", ["colima"], 10_000),
    run(ctx, "which docker", "which", ["docker"], 10_000),
    run(ctx, "which qemu-img", "which", ["qemu-img"], 10_000),
  ];
  steps.push(...preflight);
  const missing = preflight.filter((s) => !okStep(s)).map((s) => s.label.replace("which ", ""));
  if (missing.length > 0) return { ok: false, action, targetGb: target, datadisk: disk, steps: steps.map((s) => s.label), error: `missing required command(s): ${missing.join(", ")}` };

  const save = sh(
    ctx,
    "save safety manifests",
    [
      `mkdir -p ${shellQuote(backup)}`,
      `DOCKER_HOST=${shellQuote(host)} docker ps -a > ${shellQuote(join(backup, "docker-ps-a.txt"))}`,
      `DOCKER_HOST=${shellQuote(host)} docker image ls --digests > ${shellQuote(join(backup, "docker-images.txt"))}`,
      `DOCKER_HOST=${shellQuote(host)} docker volume ls > ${shellQuote(join(backup, "docker-volumes.txt"))}`,
      `DOCKER_HOST=${shellQuote(host)} docker system df -v > ${shellQuote(join(backup, "docker-system-df-before.txt"))}`,
    ].join("\n"),
  );
  steps.push(save);
  if (!okStep(save)) return fail(action, save, { targetGb: target, backupDir: backup, datadisk: disk, steps: steps.map((s) => s.label) });

  for (const step of [
    run(ctx, "prune Docker build cache", "docker", ["builder", "prune", "-af"], 900_000, { DOCKER_HOST: host }),
    run(ctx, "prune unused Docker images", "docker", ["image", "prune", "-af"], 900_000, { DOCKER_HOST: host }),
  ]) {
    steps.push(step);
    if (!okStep(step)) return fail(action, step, { targetGb: target, backupDir: backup, datadisk: disk, steps: steps.map((s) => s.label) });
  }

  const zero = run(
    ctx,
    "zero-fill Docker free space",
    "colima",
    [
      "ssh",
      "--",
      "sh",
      "-lc",
      "sudo dd if=/dev/zero of=/var/lib/docker/.zero-fill bs=64M status=progress; echo DD_RC=$?; sync; sudo rm -f /var/lib/docker/.zero-fill; echo RM_RC=$?; sync",
    ],
    1_800_000,
  );
  steps.push(zero);
  if (!okStep(zero)) return fail(action, zero, { targetGb: target, backupDir: backup, datadisk: disk, steps: steps.map((s) => s.label) });
  // dd is EXPECTED to fail with ENOSPC once it fills all free space — that's the
  // whole point of this step, so DD_RC is intentionally never checked. What must
  // never be silently lost is a failure of the rm -f cleanup: if that fails, a
  // large temp file is left behind consuming exactly the space this operation
  // exists to reclaim.
  const zeroRmRc = parseMarkerRc(output(zero), "RM_RC");
  if (zeroRmRc !== 0) {
    return fail(action, zero, {
      targetGb: target,
      backupDir: backup,
      datadisk: disk,
      steps: steps.map((s) => s.label),
      error: `zero-fill cleanup (rm -f .zero-fill inside the VM) failed with exit ${zeroRmRc ?? "unknown"} — a large temp file may remain in /var/lib/docker; ssh in and remove /var/lib/docker/.zero-fill manually before retrying`,
    });
  }

  const stop = run(ctx, "stop Colima", "colima", ["stop"], 300_000);
  steps.push(stop);
  if (!okStep(stop)) return fail(action, stop, { targetGb: target, backupDir: backup, datadisk: disk, steps: steps.map((s) => s.label) });

  const convert = sh(
    ctx,
    "qemu-img sparse convert",
    `rm -f ${shellQuote(compacted)}\nqemu-img convert -p -O raw -S 4k ${shellQuote(disk)} ${shellQuote(compacted)}`,
    3_600_000,
  );
  steps.push(convert);
  if (!okStep(convert)) return fail(action, convert, { targetGb: target, backupDir: backup, datadisk: disk, rollbackPath: rollback, steps: steps.map((s) => s.label) });

  const inspect = sh(ctx, "inspect compacted datadisk", `test -s ${shellQuote(compacted)}\ndu -h ${shellQuote(compacted)}\nqemu-img info ${shellQuote(compacted)}`, 60_000);
  steps.push(inspect);
  if (!okStep(inspect)) return fail(action, inspect, { targetGb: target, backupDir: backup, datadisk: disk, rollbackPath: rollback, steps: steps.map((s) => s.label) });

  const compactedGb = parseFirstSizeGb(inspect.result.stdout);
  const swap = sh(ctx, "swap compacted datadisk", `mv ${shellQuote(disk)} ${shellQuote(rollback)}\nmv ${shellQuote(compacted)} ${shellQuote(disk)}`, 60_000);
  steps.push(swap);
  if (!okStep(swap)) return fail(action, swap, { targetGb: target, backupDir: backup, datadisk: disk, rollbackPath: rollback, steps: steps.map((s) => s.label) });

  const start = run(ctx, "start Colima", "colima", ["start"], 600_000);
  steps.push(start);
  if (!okStep(start)) return fail(action, start, { targetGb: target, backupDir: backup, datadisk: disk, rollbackPath: rollback, rollback: `colima stop; mv ${rollback} ${disk}; colima start`, steps: steps.map((s) => s.label) });

  const verify = sh(
    ctx,
    "verify compacted Colima",
    [
      `DOCKER_HOST=${shellQuote(host)} docker ps -a`,
      `DOCKER_HOST=${shellQuote(host)} docker volume ls`,
      `DOCKER_HOST=${shellQuote(host)} docker system df`,
      "colima ssh -- df -h /var/lib/docker",
      "colima ssh -- sudo du -shx /var/lib/docker",
      `printf 'DATADISK_DU ' && du -h ${shellQuote(disk)}`,
      `qemu-img info ${shellQuote(disk)}`,
    ].join("\n"),
    300_000,
  );
  steps.push(verify);
  if (!okStep(verify)) return fail(action, verify, { targetGb: target, backupDir: backup, datadisk: disk, rollbackPath: rollback, rollback: `colima stop; mv ${rollback} ${disk}; colima start`, steps: steps.map((s) => s.label) });

  const finalDatadiskGb = parseMarkedSizeGb(verify.result.stdout, "DATADISK_DU");
  const sizeOk = finalDatadiskGb !== undefined && finalDatadiskGb <= target;
  if (!sizeOk) {
    return {
      ok: false,
      action,
      targetGb: target,
      finalDatadiskGb,
      backupDir: backup,
      datadisk: disk,
      rollbackPath: rollback,
      rollback: `colima stop; mv ${rollback} ${disk}; colima start`,
      steps: steps.map((s) => s.label),
      error: `compacted datadisk did not reach target <= ${target}GB`,
    };
  }

  const cleanup = sh(ctx, "delete verified rollback datadisk", `rm -f ${shellQuote(rollback)}`, 120_000);
  steps.push(cleanup);
  if (!okStep(cleanup)) return fail(action, cleanup, { targetGb: target, finalDatadiskGb, backupDir: backup, datadisk: disk, rollbackPath: rollback, steps: steps.map((s) => s.label) });

  return {
    ok: true,
    action,
    targetGb: target,
    finalDatadiskGb,
    compactedGb,
    backupDir: backup,
    datadisk: disk,
    preserved: ["running containers", "images used by running containers", "Docker volumes"],
    removed: ["Docker build cache", "unused Docker images", "verified rollback datadisk"],
    steps: steps.map((s) => ({ label: s.label, ok: okStep(s), exitCode: s.result.status, summary: lastNonEmpty(output(s).split("\n")) })),
  };
}

function handler(input: Record<string, unknown>, ctx: HandlerContext): ToolResultPayload {
  const action = String(input.action ?? "");

  if (action === "compact_preview") return compactPreview(input, ctx);
  if (action === "compact_run") return compactRun(input, ctx);

  if (action === "status") {
    const path = logPath(ctx.home);
    if (!existsSync(path)) return { ok: true, action, status: "no-log-yet" };
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (e) {
      return { ok: false, action, error: `cannot read log: ${e instanceof Error ? e.message : String(e)}` };
    }
    const wanted = Number(input.logLines);
    const n = Number.isFinite(wanted) && wanted > 0 ? Math.floor(wanted) : 10;
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    const tail = lines.slice(-n);
    const joined = tail.join("\n");
    return {
      ok: true,
      action,
      decision: classify(joined),
      summaryLine: lastNonEmpty(tail),
      ...scrape(joined),
      logTail: tail,
    };
  }

  if (action !== "run" && action !== "preview") {
    return { ok: false, action, error: `unknown action: ${action} (expected run|preview|status|compact_preview|compact_run)` };
  }

  const env: Record<string, string | undefined> = {};
  if (action === "preview") env.CW_DRY_RUN = "1";
  if (typeof input.freeMinGb === "number") env.CW_FREE_MIN_GB = String(input.freeMinGb);
  if (typeof input.colimaMaxGb === "number") env.CW_COLIMA_MAX_GB = String(input.colimaMaxGb);

  const r = ctx.runCommand(scriptPath(ctx.home), [], { env });
  const combined = `${r.stdout}\n${r.stderr}`;
  if (r.status !== 0) {
    return {
      ok: false,
      action,
      dryRun: action === "preview",
      exitCode: r.status,
      summaryLine: lastNonEmpty((r.stderr || r.stdout).split("\n")),
      stderr: r.stderr.trim(),
      error: r.error,
    };
  }
  return {
    ok: true,
    action,
    dryRun: action === "preview",
    exitCode: r.status,
    decision: classify(combined),
    summaryLine: lastNonEmpty(r.stdout.split("\n")),
    ...scrape(combined),
  };
}

export const colimaDisk: Capability = {
  name: "colima_disk",
  description:
    "Check or reclaim disk space used by the user's Docker/Colima VM. Call this when the user asks about disk space, Docker/Colima size, cleanup, or deep compaction. action=status reads the latest maintenance result; preview/run use the light safe cleanup; compact_preview plans the deep raw-datadisk compaction read-only and returns a planHash; compact_run requires confirm:true AND that exact planHash from a prior compact_preview call, and deletes only regenerable build cache + unused images before sparse-compacting the Colima datadisk. If the datadisk size changed since the preview (or the hash is missing/wrong), compact_run is refused and you must call compact_preview again.",
  inputSchema,
  handler,
};
