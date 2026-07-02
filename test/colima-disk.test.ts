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

function fakeCtx(home: string, run: (cmd: string, args: string[]) => CommandResult, now = () => new Date(0)) {
  const calls: Call[] = [];
  const runCommand: RunCommand = (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env });
    return run(cmd, args);
  };
  const ctx: HandlerContext = { home, env: {}, now, runCommand };
  return { ctx, calls };
}

const SKIP_LINE = "2026-07-01T00:24:57+0700 skip: under line (free 56GB >= 25, .colima 34GB <= 45)";

function homeWithDatadisk(): string {
  const home = mkdtempSync(join(tmpdir(), "chime-home-"));
  const dir = join(home, ".colima", "_lima", "_disks", "colima");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "datadisk"), "raw");
  return home;
}

function ok(stdout = ""): CommandResult {
  return { status: 0, stdout, stderr: "" };
}

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

test("compact_preview: read-only plan and current datadisk size", async () => {
  const home = homeWithDatadisk();
  try {
    const { ctx, calls } = fakeCtx(home, (cmd, args) => {
      if (cmd === "which") return ok(`/opt/homebrew/bin/${args[0]}\n`);
      if (cmd === "du") return ok(`32G\t${args[1]}\n`);
      if (cmd === "qemu-img") return ok("disk size: 31.9 GiB\n");
      if (cmd === "docker" && args.join(" ") === "system df") return ok("Build Cache     11.54GB\n");
      return ok("ok\n");
    });
    const r = await colimaDisk.handler({ action: "compact_preview", targetGb: 10 }, ctx);
    assert.equal(r.ok, true);
    assert.equal(r.applicable, true);
    assert.equal(r.currentDatadiskGb, 32);
    assert.equal(r.needsDeepCompact, true);
    assert.deepEqual(r.removes, ["Docker build cache", "unused Docker images"]);
    assert.equal(calls.some((c) => c.cmd === "docker" && c.args.includes("prune")), false);
    assert.equal(calls.some((c) => c.cmd === "colima" && c.args[0] === "stop"), false);
    assert.equal(calls.some((c) => c.cmd === "sh"), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("compact_run: requires explicit confirmation", async () => {
  const home = homeWithDatadisk();
  try {
    const { ctx, calls } = fakeCtx(home, () => ok());
    const r = await colimaDisk.handler({ action: "compact_run" }, ctx);
    assert.equal(r.ok, false);
    assert.match(String(r.error), /confirm: true/);
    assert.equal(calls.length, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("compact_run: requires planHash proving a preview happened", async () => {
  const home = homeWithDatadisk();
  try {
    const { ctx, calls } = fakeCtx(home, (cmd) => {
      if (cmd === "du") return ok("32G\t/x/datadisk\n");
      return ok();
    });
    const r = await colimaDisk.handler({ action: "compact_run", confirm: true }, ctx);
    assert.equal(r.ok, false);
    assert.match(String(r.error), /planHash/);
    assert.equal(calls.some((c) => c.cmd === "colima" && c.args[0] === "stop"), false);
    assert.equal(calls.some((c) => c.cmd === "docker"), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("compact_run: stale planHash after datadisk size changed is refused", async () => {
  const home = homeWithDatadisk();
  try {
    let duGb = "32G";
    const { ctx, calls } = fakeCtx(home, (cmd, args) => {
      if (cmd === "which") return ok(`/opt/homebrew/bin/${args[0]}\n`);
      if (cmd === "du") return ok(`${duGb}\t${args[1]}\n`);
      return ok();
    });
    const preview = await colimaDisk.handler({ action: "compact_preview", targetGb: 10 }, ctx);
    assert.equal(preview.ok, true);
    const staleHash = preview.planHash as string;

    // Datadisk size changes between preview and run (e.g. unrelated Docker activity).
    duGb = "40G";

    const r = await colimaDisk.handler({ action: "compact_run", confirm: true, planHash: staleHash, targetGb: 10 }, ctx);
    assert.equal(r.ok, false);
    assert.match(String(r.error), /planHash does not match|compact_preview again/);
    assert.equal(calls.some((c) => c.cmd === "colima" && c.args[0] === "stop"), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("compact_run: successful deep compaction sequence preserves volumes", async () => {
  const home = homeWithDatadisk();
  const now = () => new Date("2026-07-02T10:45:58.000Z");
  try {
    const { ctx, calls } = fakeCtx(
      home,
      (cmd, args) => {
        const joined = args.join(" ");
        if (cmd === "which") return ok(`/opt/homebrew/bin/${args[0]}\n`);
        if (cmd === "docker" && joined === "builder prune -af") return ok("Total: 11.54GB\n");
        if (cmd === "docker" && joined === "image prune -af") return ok("Total reclaimed space: 3.286GB\n");
        if (cmd === "colima" && joined.startsWith("ssh")) return ok("DD_RC=1\nRM_RC=0\n");
        if (cmd === "colima" && joined === "stop") return ok("done\n");
        if (cmd === "colima" && joined === "start") return ok("done\n");
        if (cmd === "sh") {
          const script = args[1] ?? "";
          if (script.includes("docker-system-df-before.txt")) return ok();
          if (script.includes("qemu-img convert")) return ok("(100.00/100%)\n");
          if (script.includes("test -s") && script.includes("datadisk.compacted")) return ok("8.7G\tdatadisk.compacted\ndisk size: 8.67 GiB\n");
          if (script.includes("mv") && script.includes("before-final-compact")) return ok();
          if (script.includes("DATADISK_DU")) return ok("CONTAINER ID   IMAGE\nVOLUME NAME\nDATADISK_DU 8.1G\t/home/x/.colima/_lima/_disks/colima/datadisk\n");
          if (script.includes("rm -f") && script.includes("before-final-compact")) return ok();
        }
        return ok();
      },
      now,
    );
    const preview = await colimaDisk.handler({ action: "compact_preview" }, ctx);
    const r = await colimaDisk.handler({ action: "compact_run", confirm: true, planHash: preview.planHash }, ctx);
    assert.equal(r.ok, true);
    assert.equal(r.finalDatadiskGb, 8.1);
    assert.equal(r.targetGb, 10);
    assert.match(String(r.backupDir), /\.chime\/colima-compact\/20260702T104558Z$/);

    const compactCalls = calls.map((c) => `${c.cmd} ${c.args.join(" ")}`);
    assert.ok(compactCalls.findIndex((s) => s.includes("docker-system-df-before.txt")) < compactCalls.findIndex((s) => s.includes("docker builder prune -af")));
    assert.ok(compactCalls.findIndex((s) => s.includes("docker builder prune -af")) < compactCalls.findIndex((s) => s.includes("docker image prune -af")));
    assert.ok(compactCalls.findIndex((s) => s.includes("docker image prune -af")) < compactCalls.findIndex((s) => s.includes("colima ssh")));
    assert.ok(compactCalls.findIndex((s) => s.includes("colima stop")) < compactCalls.findIndex((s) => s.includes("qemu-img convert")));
    assert.ok(compactCalls.findIndex((s) => s.includes("before-final-compact")) < compactCalls.findIndex((s) => s.includes("colima start")));
    assert.ok(compactCalls.some((s) => s.includes("rm -f") && s.includes("before-final-compact")));
    assert.equal(compactCalls.some((s) => s.includes("docker volume prune")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("compact_run: zero-fill cleanup failure is detected and fails the step", async () => {
  const home = homeWithDatadisk();
  try {
    const { ctx, calls } = fakeCtx(home, (cmd, args) => {
      const joined = args.join(" ");
      if (cmd === "which") return ok();
      if (cmd === "colima" && joined.startsWith("ssh")) return ok("DD_RC=1\nRM_RC=1\n");
      return ok();
    });
    const preview = await colimaDisk.handler({ action: "compact_preview" }, ctx);
    const r = await colimaDisk.handler({ action: "compact_run", confirm: true, planHash: preview.planHash }, ctx);
    assert.equal(r.ok, false);
    assert.equal(r.failedStep, "zero-fill Docker free space");
    assert.match(String(r.error), /cleanup.*failed/i);
    assert.equal(calls.some((c) => c.cmd === "colima" && c.args[0] === "stop"), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("compact_run: dd ENOSPC with successful cleanup still proceeds past zero-fill", async () => {
  const home = homeWithDatadisk();
  try {
    const { ctx, calls } = fakeCtx(home, (cmd, args) => {
      const joined = args.join(" ");
      if (cmd === "which") return ok();
      if (cmd === "colima" && joined.startsWith("ssh")) return ok("DD_RC=1\nRM_RC=0\n");
      if (cmd === "sh" && (args[1] ?? "").includes("qemu-img convert")) return { status: 1, stdout: "", stderr: "convert failed" };
      return ok();
    });
    const preview = await colimaDisk.handler({ action: "compact_preview" }, ctx);
    const r = await colimaDisk.handler({ action: "compact_run", confirm: true, planHash: preview.planHash }, ctx);
    assert.equal(r.failedStep, "qemu-img sparse convert");
    assert.equal(calls.some((c) => c.cmd === "colima" && c.args[0] === "stop"), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("compact_run: qemu-img convert failure does not swap datadisk", async () => {
  const home = homeWithDatadisk();
  try {
    const { ctx, calls } = fakeCtx(home, (cmd, args) => {
      if (cmd === "which") return ok();
      if (cmd === "colima" && args.join(" ").startsWith("ssh")) return ok("DD_RC=1\nRM_RC=0\n");
      if (cmd === "sh" && (args[1] ?? "").includes("qemu-img convert")) return { status: 1, stdout: "", stderr: "convert failed" };
      return ok();
    });
    const preview = await colimaDisk.handler({ action: "compact_preview" }, ctx);
    const r = await colimaDisk.handler({ action: "compact_run", confirm: true, planHash: preview.planHash }, ctx);
    assert.equal(r.ok, false);
    assert.equal(r.failedStep, "qemu-img sparse convert");
    assert.equal(calls.some((c) => c.cmd === "sh" && (c.args[1] ?? "").includes("mv") && (c.args[1] ?? "").includes("before-final-compact")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("compact_run: start failure keeps rollback instructions", async () => {
  const home = homeWithDatadisk();
  try {
    const { ctx } = fakeCtx(home, (cmd, args) => {
      const script = args[1] ?? "";
      if (cmd === "which") return ok();
      if (cmd === "colima" && args.join(" ").startsWith("ssh")) return ok("DD_RC=1\nRM_RC=0\n");
      if (cmd === "sh" && script.includes("test -s")) return ok("8.7G\tdatadisk.compacted\n");
      if (cmd === "colima" && args.join(" ") === "start") return { status: 1, stdout: "", stderr: "boot failed" };
      return ok();
    });
    const preview = await colimaDisk.handler({ action: "compact_preview" }, ctx);
    const r = await colimaDisk.handler({ action: "compact_run", confirm: true, planHash: preview.planHash }, ctx);
    assert.equal(r.ok, false);
    assert.equal(r.failedStep, "start Colima");
    assert.match(String(r.rollbackPath), /datadisk\.before-final-compact/);
    assert.match(String(r.rollback), /colima stop; mv .*datadisk/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("compact_run: over-target compacted disk is not reported as success", async () => {
  const home = homeWithDatadisk();
  try {
    const { ctx, calls } = fakeCtx(home, (cmd, args) => {
      const script = args[1] ?? "";
      if (cmd === "which") return ok();
      if (cmd === "colima" && args.join(" ").startsWith("ssh")) return ok("DD_RC=1\nRM_RC=0\n");
      if (cmd === "sh" && script.includes("test -s")) return ok("12G\tdatadisk.compacted\n");
      if (cmd === "sh" && script.includes("DATADISK_DU")) return ok("DATADISK_DU 12G\t/home/x/.colima/_lima/_disks/colima/datadisk\n");
      return ok();
    });
    const preview = await colimaDisk.handler({ action: "compact_preview", targetGb: 10 }, ctx);
    const r = await colimaDisk.handler({ action: "compact_run", confirm: true, targetGb: 10, planHash: preview.planHash }, ctx);
    assert.equal(r.ok, false);
    assert.equal(r.finalDatadiskGb, 12);
    assert.match(String(r.error), /did not reach target/);
    assert.equal(calls.some((c) => c.cmd === "sh" && (c.args[1] ?? "").includes("rm -f") && (c.args[1] ?? "").includes("before-final-compact")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
