import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Capability, HandlerContext, JsonSchema, ToolResultPayload } from "../types.ts";

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
      enum: ["run", "preview", "status"],
      description:
        "run = reclaim space now (safe: dangling images + fstrim); preview = dry-run that changes nothing; status = read the most recent result from the log",
    },
    freeMinGb: { type: "number", description: "override CW_FREE_MIN_GB (the free-space trigger, GB)" },
    colimaMaxGb: { type: "number", description: "override CW_COLIMA_MAX_GB (the .colima-size trigger, GB)" },
    logLines: { type: "number", description: "status only: how many recent log lines to read (default 10)" },
  },
  required: ["action"],
  additionalProperties: false,
};

function handler(input: Record<string, unknown>, ctx: HandlerContext): ToolResultPayload {
  const action = String(input.action ?? "");

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
    return { ok: false, action, error: `unknown action: ${action} (expected run|preview|status)` };
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
    "Check or reclaim disk space used by the user's Docker/Colima VM. Call this when the user asks about disk space, Docker/Colima size, or wants to clean up / free space. action=status reads the most recent maintenance result (read-only); action=preview dry-runs the cleanup and reports what it WOULD do without changing anything; action=run reclaims now (safe: dangling images + fstrim only).",
  inputSchema,
  handler,
};
