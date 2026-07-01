import { test } from "node:test";
import assert from "node:assert/strict";
import { projectCheck, checkProject } from "../src/tools/project-check.ts";
import type { CommandResult, HandlerContext, RunCommand } from "../src/types.ts";
import type { Project } from "../src/projects.ts";

function ctxReturning(res: CommandResult, spy?: { cmd?: string; args?: string[]; cwd?: string }): HandlerContext {
  const runCommand: RunCommand = (cmd, args, opts): CommandResult => {
    if (spy) {
      spy.cmd = cmd;
      spy.args = args;
      spy.cwd = opts?.cwd;
    }
    return res;
  };
  return { runCommand, env: {}, now: () => new Date(0), home: "/home" };
}

const base: Project = {
  name: "demo",
  path: "Developer/demo",
  kind: "x",
  summary: "y",
  remotes: [],
  check: ["pnpm", "lint"],
  fullGate: "pnpm lint && pnpm test && pnpm build",
};

test("exit 0 is a PASS", () => {
  const spy: { cwd?: string; args?: string[] } = {};
  const r = checkProject(base, ctxReturning({ status: 0, stdout: "ok", stderr: "" }, spy));
  assert.equal(r.ok, true);
  assert.equal(r.pass, true);
  assert.equal(r.exitCode, 0);
  // ran in the repo's check dir, with the argv from the registry
  assert.equal(spy.cwd, "/home/Developer/demo");
  assert.deepEqual(spy.args, ["lint"]);
});

test("non-zero exit is a FAIL that still ran (ok:true, pass:false, tail)", () => {
  const r = checkProject(base, ctxReturning({ status: 1, stdout: "line1\nlint error here\n", stderr: "" }));
  assert.equal(r.ok, true);
  assert.equal(r.pass, false);
  assert.match((r.tail as string[]).join("\n"), /lint error here/);
});

test("a spawn error / timeout fails closed and shows the full gate", () => {
  const r = checkProject(base, ctxReturning({ status: null, stdout: "", stderr: "", error: "ETIMEDOUT" }));
  assert.equal(r.ok, false);
  assert.match(String(r.error), /ETIMEDOUT|could not run/i);
  assert.equal(r.fullGate, "pnpm lint && pnpm test && pnpm build");
});

test("a project with no check command says so (read-only, no run)", () => {
  const noCheck: Project = { ...base, check: undefined };
  const r = checkProject(noCheck, ctxReturning({ status: 0, stdout: "SHOULD NOT RUN", stderr: "" }));
  assert.equal(r.ok, true);
  assert.match(String(r.note), /no check/i);
});

test("checkDir sub-path is honored", () => {
  const nested: Project = { ...base, checkDir: "plugins/x" };
  const spy: { cwd?: string } = {};
  checkProject(nested, ctxReturning({ status: 0, stdout: "", stderr: "" }, spy));
  assert.equal(spy.cwd, "/home/Developer/demo/plugins/x");
});

test("the tool handler fails closed on an unknown project", () => {
  const r = projectCheck.handler({ name: "nope" }, ctxReturning({ status: 0, stdout: "", stderr: "" }));
  assert.equal((r as { ok: boolean }).ok, false);
});
