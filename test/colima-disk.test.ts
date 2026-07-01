import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { colimaDisk } from "../src/tools/colima-disk.ts";
import type { CommandResult, HandlerContext, RunCommand } from "../src/types.ts";

interface Call {
  cmd: string;
  args: string[];
  env?: Record<string, string | undefined>;
}

function fakeCtx(home: string, run: (cmd: string, args: string[]) => CommandResult) {
  const calls: Call[] = [];
  const runCommand: RunCommand = (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env });
    return run(cmd, args);
  };
  const ctx: HandlerContext = { home, env: {}, now: () => new Date(0), runCommand };
  return { ctx, calls };
}

const SKIP_LINE = "2026-07-01T00:24:57+0700 skip: under line (free 56GB >= 25, .colima 34GB <= 45)";

test("preview: sets CW_DRY_RUN=1, maps overrides, parses decision + sizes", async () => {
  const { ctx, calls } = fakeCtx("/home/x", () => ({ status: 0, stdout: `${SKIP_LINE}\n`, stderr: "" }));
  const r = await colimaDisk.handler({ action: "preview", colimaMaxGb: 45, freeMinGb: 25 }, ctx);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.cmd, /colima-disk-maintenance/);
  assert.equal(calls[0]!.env?.CW_DRY_RUN, "1");
  assert.equal(calls[0]!.env?.CW_COLIMA_MAX_GB, "45");
  assert.equal(calls[0]!.env?.CW_FREE_MIN_GB, "25");
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.decision, "skip");
  assert.equal(r.freeGb, 56);
  assert.equal(r.colimaGb, 34);
  assert.match(String(r.summaryLine), /skip: under line/);
});

test("run: no CW_DRY_RUN; reclaimed parsed", async () => {
  const out =
    "2026-07-01T01:00:00+0700 act: over line (free 20GB, .colima 50GB)\n" +
    "2026-07-01T01:00:05+0700 reclaimed: .colima 50->30GB, free 20->40GB\n";
  const { ctx, calls } = fakeCtx("/home/x", () => ({ status: 0, stdout: out, stderr: "" }));
  const r = await colimaDisk.handler({ action: "run" }, ctx);
  assert.equal(calls[0]!.env?.CW_DRY_RUN, undefined);
  assert.equal(r.ok, true);
  assert.equal(r.decision, "reclaimed");
});

test("status: reads log tail from ctx.home and parses", async () => {
  const home = mkdtempSync(join(tmpdir(), "chime-home-"));
  const logDir = join(home, "Library", "Logs");
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, "colima-disk-maintenance.log"), `${SKIP_LINE}\n`);
  try {
    const { ctx } = fakeCtx(home, () => ({ status: 0, stdout: "", stderr: "" }));
    const r = await colimaDisk.handler({ action: "status", logLines: 5 }, ctx);
    assert.equal(r.ok, true);
    assert.equal(r.decision, "skip");
    assert.deepEqual(r.logTail, [SKIP_LINE]);
    assert.equal(r.freeGb, 56);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("status: missing log → no-log-yet (fail-soft, read-only query)", async () => {
  const { ctx } = fakeCtx("/no/such/home", () => ({ status: 0, stdout: "", stderr: "" }));
  const r = await colimaDisk.handler({ action: "status" }, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.status, "no-log-yet");
});

test("non-zero exit → ok:false with exitCode", async () => {
  const { ctx } = fakeCtx("/home/x", () => ({ status: 1, stdout: "", stderr: "boom" }));
  const r = await colimaDisk.handler({ action: "run" }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 1);
});
