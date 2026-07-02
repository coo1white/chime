import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync, symlinkSync } from "node:fs";
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

    const preview = await runTool({ action: "preview", task: "clean-dev-cache" }, f.ctx);
    const r = await runTool({ action: "run", task: "clean-dev-cache", planHash: preview.planHash }, f.ctx);
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

    const preview = await runTool({ action: "preview", task: "compress-cold-files", minSizeMb: 1 }, f.ctx);
    const r = await runTool({ action: "run", task: "compress-cold-files", minSizeMb: 1, planHash: preview.planHash }, f.ctx);
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

    const preview = await runTool({ action: "preview", task: "compress-cold-files", minSizeMb: 1 }, f.ctx);
    const r = await runTool({ action: "run", task: "compress-cold-files", minSizeMb: 1, planHash: preview.planHash }, f.ctx);
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
    assert.match(String(r.error), /not permitted/);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SECURITY REGRESSION TESTS — each reproduces one PoC-confirmed hole and
// asserts it's closed.
// ---------------------------------------------------------------------------

test("scan does not traverse a symlinked directory under an allowed root", async () => {
  const h = home();
  const outside = mkdtempSync(join(tmpdir(), "chime-outside-"));
  try {
    mkdirSync(join(h, "Downloads"), { recursive: true });
    const secretFile = join(outside, "secret.log");
    writeFileSync(secretFile, "x".repeat(2 * 1024 * 1024));
    old(secretFile);
    symlinkSync(outside, join(h, "Downloads", "evil-link"));
    const f = ctx(h);

    const r = await runTool({ action: "scan", minSizeMb: 1 }, f.ctx);
    assert.equal(r.ok, true);
    assert.equal((r.candidates as { path: string }[]).some((c) => c.path.startsWith(outside)), false);
    assert.ok((r.skipped as { path: string; reason: string }[]).some((s) => s.reason.includes("symlink")));
  } finally {
    rmSync(h, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("run never deletes through a symlinked project build dir", async () => {
  const h = home();
  const outside = mkdtempSync(join(tmpdir(), "chime-outside-"));
  try {
    mkdirSync(join(h, "Developer", "proj"), { recursive: true });
    const realBuild = join(outside, "node_modules");
    mkdirSync(realBuild, { recursive: true });
    writeFileSync(join(realBuild, "keep.txt"), "x".repeat(2 * 1024 * 1024));
    old(realBuild);
    symlinkSync(realBuild, join(h, "Developer", "proj", "node_modules"));
    const f = ctx(h);

    const preview = await runTool({ action: "preview", task: "clean-dev-cache", includeProjectBuilds: true }, f.ctx);
    const r = await runTool({ action: "run", task: "clean-dev-cache", includeProjectBuilds: true, planHash: preview.planHash }, f.ctx);
    assert.equal(r.ok, true);
    assert.equal(existsSync(join(realBuild, "keep.txt")), true);
  } finally {
    rmSync(h, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("scan protects dotfile directories even when passed directly as a custom root", async () => {
  const h = home();
  try {
    mkdirSync(join(h, ".ssh"), { recursive: true });
    const key = join(h, ".ssh", "id_ed25519.bak");
    writeFileSync(key, "x".repeat(2 * 1024 * 1024));
    old(key);
    const f = ctx(h);

    const r = await runTool({ action: "scan", roots: [join(h, ".ssh")], minSizeMb: 1 }, f.ctx);
    assert.equal(r.ok, true);
    assert.equal((r.candidates as unknown[]).length, 0);
    assert.ok((r.skipped as { path: string; reason: string }[]).some((s) => s.reason === "protected path"));
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("scan rejects roots:['~'] outright", async () => {
  const h = home();
  try {
    const f = ctx(h);
    const r = await runTool({ action: "scan", roots: ["~"] }, f.ctx);
    assert.equal(r.ok, false);
    assert.match(String(r.error), /not permitted/);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("minAgeDays:0 falls back to the safe default instead of matching everything", async () => {
  const h = home();
  try {
    mkdirSync(join(h, "Downloads"), { recursive: true });
    const fresh = join(h, "Downloads", "fresh.log");
    writeFileSync(fresh, "x".repeat(2 * 1024 * 1024)); // mtime = now, not aged via old()
    const f = ctx(h);

    const r = await runTool({ action: "scan", minAgeDays: 0, minSizeMb: 1 }, f.ctx);
    assert.equal(r.ok, true);
    assert.equal((r.candidates as { path: string }[]).some((c) => c.path === fresh), false);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("minSizeMb:0 falls back to the safe default instead of matching everything", async () => {
  const h = home();
  try {
    mkdirSync(join(h, "Downloads"), { recursive: true });
    const small = join(h, "Downloads", "small.log");
    writeFileSync(small, "tiny");
    old(small);
    const f = ctx(h);

    const r = await runTool({ action: "scan", minSizeMb: 0 }, f.ctx);
    assert.equal(r.ok, true);
    assert.equal((r.candidates as { path: string }[]).some((c) => c.path === small), false);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("project build dir with a fresh file inside is not flagged stale", async () => {
  const h = home();
  try {
    const nm = join(h, "Developer", "proj", "node_modules");
    mkdirSync(join(nm, "some-pkg"), { recursive: true });
    const pkgFile = join(nm, "some-pkg", "index.js");
    writeFileSync(pkgFile, "module.exports = {};");
    old(join(nm, "some-pkg"));
    old(nm);
    // Content-only rewrite of an existing file bumps only the file's own mtime,
    // not any ancestor directory's — simulates an actively used tree.
    writeFileSync(pkgFile, "module.exports = { touched: true };");
    const f = ctx(h);

    const r = await runTool({ action: "scan", task: "clean-dev-cache", includeProjectBuilds: true }, f.ctx);
    assert.equal(r.ok, true);
    assert.equal((r.candidates as { path: string; kind: string }[]).some((c) => c.kind === "project-build" && c.path === nm), false);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("project build dir with everything old is still flagged stale", async () => {
  const h = home();
  try {
    const dist = join(h, "Developer", "proj", "dist");
    mkdirSync(dist, { recursive: true });
    const f1 = join(dist, "bundle.js");
    writeFileSync(f1, "x".repeat(2 * 1024 * 1024));
    old(f1);
    old(dist);
    const f = ctx(h);

    const r = await runTool({ action: "scan", task: "clean-dev-cache", includeProjectBuilds: true }, f.ctx);
    assert.ok((r.candidates as { path: string; kind: string }[]).some((c) => c.kind === "project-build" && c.path === dist));
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("case-variant .APP bundle segment is still protected", async () => {
  const h = home();
  try {
    mkdirSync(join(h, "Downloads", "Foo.APP", "Contents"), { recursive: true });
    const inner = join(h, "Downloads", "Foo.APP", "Contents", "old.log");
    writeFileSync(inner, "x".repeat(2 * 1024 * 1024));
    old(inner);
    const f = ctx(h);

    const r = await runTool({ action: "scan", minSizeMb: 1 }, f.ctx);
    assert.equal(r.ok, true);
    assert.equal((r.candidates as { path: string }[]).some((c) => c.path === inner), false);
    assert.ok((r.skipped as { path: string; reason: string }[]).some((s) => s.reason === "protected path"));
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("run without planHash is refused and deletes nothing", async () => {
  const h = home();
  try {
    mkdirSync(join(h, "Downloads"), { recursive: true });
    const log = join(h, "Downloads", "old.log");
    writeFileSync(log, "x".repeat(2 * 1024 * 1024));
    old(log);
    const f = ctx(h);

    const r = await runTool({ action: "run", task: "compress-cold-files", minSizeMb: 1 }, f.ctx);
    assert.equal(r.ok, false);
    assert.match(String(r.error), /planHash/);
    assert.equal(existsSync(log), true);
    assert.equal(f.calls.length, 0);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("run with a stale planHash after candidates changed is refused, forcing a fresh preview", async () => {
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

    const preview = await runTool({ action: "preview", task: "compress-cold-files", minSizeMb: 1 }, f.ctx);
    assert.equal(preview.ok, true);
    const staleHash = preview.planHash as string;

    // Filesystem drifts: a second old file appears after preview, before run.
    const log2 = join(h, "Downloads", "old2.log");
    writeFileSync(log2, "y".repeat(2 * 1024 * 1024));
    old(log2);

    const run = await runTool({ action: "run", task: "compress-cold-files", minSizeMb: 1, planHash: staleHash }, f.ctx);
    assert.equal(run.ok, false);
    assert.match(String(run.error), /planHash does not match|preview again/);
    assert.equal(existsSync(log), true);
    assert.equal(existsSync(log2), true);

    // Boring recovery: a fresh preview + its planHash succeeds.
    const freshPreview = await runTool({ action: "preview", task: "compress-cold-files", minSizeMb: 1 }, f.ctx);
    const freshRun = await runTool({ action: "run", task: "compress-cold-files", minSizeMb: 1, planHash: freshPreview.planHash }, f.ctx);
    assert.equal(freshRun.ok, true);
    assert.equal(existsSync(log), false);
    assert.equal(existsSync(log2), false);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});
