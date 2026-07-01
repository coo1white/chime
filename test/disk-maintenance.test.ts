import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diskMaintenance } from "../src/tools/disk-maintenance.ts";
import type { CommandResult, HandlerContext, RunCommand } from "../src/types.ts";

interface Call {
  cmd: string;
  args: string[];
}

function home(): string {
  return mkdtempSync(join(tmpdir(), "chime-disk-"));
}

function old(path: string): void {
  const d = new Date("2026-05-01T00:00:00Z");
  utimesSync(path, d, d);
}

function ctx(homeDir: string, run?: RunCommand): { ctx: HandlerContext; calls: Call[] } {
  const calls: Call[] = [];
  const runCommand: RunCommand = (cmd, args, opts) => {
    calls.push({ cmd, args });
    if (run) return run(cmd, args, opts);
    return { status: 0, stdout: "", stderr: "" };
  };
  return { ctx: { home: homeDir, env: {}, now: () => new Date("2026-07-01T00:00:00Z"), runCommand }, calls };
}

async function runTool(input: Record<string, unknown>, h: HandlerContext) {
  return await diskMaintenance.handler(input, h);
}

test("scan finds known cache and cold-file candidates without mutating commands", async () => {
  const h = home();
  try {
    mkdirSync(join(h, ".npm"), { recursive: true });
    writeFileSync(join(h, ".npm", "blob"), "x".repeat(2 * 1024 * 1024));
    mkdirSync(join(h, "Downloads"), { recursive: true });
    const log = join(h, "Downloads", "old.log");
    writeFileSync(log, "x".repeat(2 * 1024 * 1024));
    old(log);
    const f = ctx(h, () => {
      throw new Error("scan must not shell out");
    });

    const r = await runTool({ action: "scan", minSizeMb: 1 }, f.ctx);
    assert.equal(r.ok, true);
    assert.equal(f.calls.length, 0);
    assert.equal(r.dryRun, false);
    assert.ok((r.candidates as unknown[]).some((c) => (c as { kind: string }).kind === "dev-cache"));
    assert.ok((r.candidates as unknown[]).some((c) => (c as { kind: string }).kind === "cold-file"));
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("preview returns commands and leaves source files alone", async () => {
  const h = home();
  try {
    mkdirSync(join(h, "Downloads"), { recursive: true });
    const log = join(h, "Downloads", "old.log");
    writeFileSync(log, "x".repeat(2 * 1024 * 1024));
    old(log);
    const f = ctx(h);

    const r = await runTool({ action: "preview", task: "compress-cold-files", minSizeMb: 1 }, f.ctx);
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.equal(f.calls.length, 0);
    assert.ok(existsSync(log));
    assert.match((r.commands as string[])[0]!, /tar -czf/);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("run invokes allowlisted cache commands through runCommand", async () => {
  const h = home();
  try {
    const f = ctx(h, (cmd, args) => {
      if (cmd === "which") return { status: 0, stdout: `${args[0]}\n`, stderr: "" };
      if (cmd.includes("colima-disk-maintenance")) return { status: 0, stdout: "reclaimed: .colima 1->1GB, free 1->1GB\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    });

    const r = await runTool({ action: "run", task: "clean-dev-cache" }, f.ctx);
    assert.equal(r.ok, true);
    assert.deepEqual(
      f.calls.filter((c) => c.cmd !== "which" && !c.cmd.includes("colima-disk-maintenance")).map((c) => [c.cmd, c.args]),
      [
        ["npm", ["cache", "clean", "--force"]],
        ["pnpm", ["store", "prune"]],
        ["pip", ["cache", "purge"]],
        ["bun", ["pm", "cache", "rm"]],
        ["brew", ["cleanup"]],
      ],
    );
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("run compresses an old text file, verifies archive, and deletes source", async () => {
  const h = home();
  try {
    mkdirSync(join(h, "Downloads"), { recursive: true });
    const log = join(h, "Downloads", "old.log");
    writeFileSync(log, "x".repeat(2 * 1024 * 1024));
    old(log);
    const f = ctx(h, (cmd, args, opts) => {
      if (cmd !== "tar") return { status: 1, stdout: "", stderr: "unexpected command" };
      const r = spawnSync(cmd, args, { encoding: "utf8", cwd: opts?.cwd });
      return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error?.message };
    });

    const r = await runTool({ action: "run", task: "compress-cold-files", minSizeMb: 1 }, f.ctx);
    assert.equal(r.ok, true);
    assert.equal(existsSync(log), false);
    assert.equal(existsSync(`${log}.tar.gz`), true);
    assert.equal(f.calls.filter((c) => c.cmd === "tar").length, 2);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("compression failure keeps source file", async () => {
  const h = home();
  try {
    mkdirSync(join(h, "Downloads"), { recursive: true });
    const log = join(h, "Downloads", "old.log");
    writeFileSync(log, "x".repeat(2 * 1024 * 1024));
    old(log);
    const f = ctx(h, (cmd) => (cmd === "tar" ? { status: 1, stdout: "", stderr: "tar failed" } : { status: 0, stdout: "", stderr: "" }));

    const r = await runTool({ action: "run", task: "compress-cold-files", minSizeMb: 1 }, f.ctx);
    assert.equal(r.ok, false);
    assert.equal(existsSync(log), true);
    assert.match((r.errors as string[])[0]!, /tar failed/);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("path guard rejects roots outside home", async () => {
  const h = home();
  try {
    const f = ctx(h);
    const r = await runTool({ action: "scan", roots: ["/tmp"] }, f.ctx);
    assert.equal(r.ok, false);
    assert.match(String(r.error), /outside home/);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});
