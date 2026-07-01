import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registryPath, type Project } from "../src/projects.ts";
import { selfIteration } from "../src/tools/self-iteration.ts";
import type { CommandResult, HandlerContext, RunCommand } from "../src/types.ts";

const FIXTURE: Project[] = [
  { name: "demo", path: "Developer/demo", kind: "TS CLI", summary: "x", remotes: [] },
];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "chime-self-"));
  mkdirSync(join(home, ".chime"), { recursive: true });
  mkdirSync(join(home, "Developer", "demo"), { recursive: true });
  writeFileSync(registryPath(home), JSON.stringify(FIXTURE));
  return home;
}

function ctx(home: string, porcelain = ""): HandlerContext {
  const runCommand: RunCommand = (cmd, args): CommandResult => {
    if (cmd !== "git") return { status: 127, stdout: "", stderr: "unexpected cmd" };
    if (args.includes("rev-parse")) return { status: 0, stdout: "main\n", stderr: "" };
    if (args.includes("status")) return { status: 0, stdout: porcelain, stderr: "" };
    if (args.includes("log")) return { status: 0, stdout: "abc1234 latest\n", stderr: "" };
    return { status: 1, stdout: "", stderr: "unhandled" };
  };
  return { home, env: {}, now: () => new Date(0), runCommand };
}

test("self_iteration: clean tree returns the standard loop and next branch step", async () => {
  const home = tempHome();
  const r = await selfIteration.handler({ name: "demo" }, ctx(home));
  assert.equal(r.ok, true);
  assert.equal(r.dirty, false);
  assert.deepEqual(r.changedFiles, []);
  assert.match(String((r.loop as string[])[0]), /look/);
  assert.deepEqual(r.nextSteps, ["start a feature branch before editing"]);
});

test("self_iteration: dirty tree classifies staged, unstaged, and untracked files", async () => {
  const home = tempHome();
  const porcelain = "M  src/a.ts\n M src/b.ts\n?? test/c.test.ts\n";
  const r = await selfIteration.handler({ name: "demo" }, ctx(home, porcelain));
  assert.equal(r.ok, true);
  assert.equal(r.dirty, true);
  assert.deepEqual(r.staged, ["src/a.ts"]);
  assert.deepEqual(r.unstaged, ["src/b.ts"]);
  assert.deepEqual(r.untracked, ["test/c.test.ts"]);
  assert.ok((r.findings as string[]).some((f) => /unrelated changes/.test(f)));
});

test("self_iteration: unknown project fails closed", async () => {
  const home = tempHome();
  const r = await selfIteration.handler({ name: "nope" }, ctx(home));
  assert.equal(r.ok, false);
  assert.match(String(r.error), /unknown project/);
});
