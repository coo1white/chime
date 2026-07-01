import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectStatus } from "../src/tools/project-status.ts";
import { registryPath, type Project } from "../src/projects.ts";
import type { CommandResult, HandlerContext, RunCommand } from "../src/types.ts";

const FIXTURE: Project[] = [
  { name: "demo-web", path: "Developer/demo-web", kind: "app", summary: "y", remotes: [], versionFile: "package.json", versionKind: "json" },
];

// A fake git: answers by the subcommand in argv. `porcelain` controls dirty state,
// `fail` makes every git call error out.
function fakeCtx(opts: { home: string; porcelain?: string; fail?: boolean }): HandlerContext {
  const runCommand: RunCommand = (cmd, args): CommandResult => {
    if (cmd !== "git") return { status: 127, stdout: "", stderr: "not git", error: "unexpected cmd" };
    if (opts.fail) return { status: 128, stdout: "", stderr: "fatal: not a git repo" };
    if (args.includes("rev-parse")) return { status: 0, stdout: "main\n", stderr: "" };
    if (args.includes("status")) return { status: 0, stdout: opts.porcelain ?? "", stderr: "" };
    if (args.includes("log")) return { status: 0, stdout: "abc1234 latest commit\n", stderr: "" };
    return { status: 1, stdout: "", stderr: "unhandled" };
  };
  return { runCommand, env: {}, now: () => new Date(0), home: opts.home };
}

// Build a temp home with the registry fixture AND the repo's version file present.
function tempHome(version = "0.1.0"): string {
  const home = mkdtempSync(join(tmpdir(), "chime-status-"));
  mkdirSync(join(home, ".chime"), { recursive: true });
  writeFileSync(registryPath(home), JSON.stringify(FIXTURE));
  const dir = join(home, "Developer", "demo-web");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo-web", version }));
  return home;
}

test("status of one clean project reports branch, head, version", async () => {
  const home = tempHome("0.1.0");
  const r = await projectStatus.handler({ name: "demo-web" }, fakeCtx({ home }));
  assert.equal(r.ok, true);
  assert.equal(r.name, "demo-web");
  assert.equal(r.branch, "main");
  assert.equal(r.dirty, false);
  assert.match(String(r.head), /abc1234/);
  assert.equal(r.version, "0.1.0");
});

test("a non-empty porcelain marks the tree dirty", async () => {
  const home = tempHome();
  const r = await projectStatus.handler({ name: "demo-web" }, fakeCtx({ home, porcelain: " M src/x.ts\n" }));
  assert.equal(r.dirty, true);
});

test("git failure fails soft — no throw, fields noted", async () => {
  const home = tempHome("0.1.0");
  const r = await projectStatus.handler({ name: "demo-web" }, fakeCtx({ home, fail: true }));
  assert.equal(r.ok, true);
  assert.match(String(r.gitError ?? r.branch), /repo|unknown|fatal/i);
  assert.equal(r.version, "0.1.0");
});

test("name=all returns one row per registered project", async () => {
  const home = tempHome();
  const r = await projectStatus.handler({ name: "all" }, fakeCtx({ home }));
  assert.equal(r.ok, true);
  const rows = r.projects as { name: string }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.name, "demo-web");
});

test("unknown project fails closed", async () => {
  const home = tempHome();
  const r = await projectStatus.handler({ name: "nope" }, fakeCtx({ home }));
  assert.equal(r.ok, false);
});
