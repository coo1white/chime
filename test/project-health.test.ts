import { test } from "node:test";
import assert from "node:assert/strict";
import { projectHealth, checkHealth } from "../src/tools/project-health.ts";
import type { CommandResult, HandlerContext, RunCommand } from "../src/types.ts";
import type { Project } from "../src/projects.ts";

function ctxReturning(res: CommandResult, spy?: { args?: string[] }): HandlerContext {
  const runCommand: RunCommand = (_cmd, args): CommandResult => {
    if (spy) spy.args = args;
    return res;
  };
  return { runCommand, env: {}, now: () => new Date(0), home: "/home" };
}

const deployed: Project = {
  name: "demo",
  path: "Developer/demo",
  kind: "x",
  summary: "y",
  remotes: [],
  deployedUrl: "https://demo.example/health",
};

test("HTTP 200 is up", () => {
  const spy: { args?: string[] } = {};
  const r = checkHealth(deployed, ctxReturning({ status: 0, stdout: "200", stderr: "" }, spy));
  assert.equal(r.ok, true);
  assert.equal(r.up, true);
  assert.equal(r.httpCode, "200");
  assert.ok(spy.args?.includes("https://demo.example/health"));
});

test("a 5xx (curl -f exits non-zero) is down with the code", () => {
  const r = checkHealth(deployed, ctxReturning({ status: 22, stdout: "503", stderr: "" }));
  assert.equal(r.ok, true);
  assert.equal(r.up, false);
  assert.equal(r.httpCode, "503");
});

test("a connect failure is down with code 000", () => {
  const r = checkHealth(deployed, ctxReturning({ status: 7, stdout: "", stderr: "conn refused" }));
  assert.equal(r.up, false);
  assert.equal(r.httpCode, "000");
});

test("no deployed url returns a note (nothing to curl)", () => {
  const noUrl: Project = { ...deployed, deployedUrl: undefined };
  const r = checkHealth(noUrl, ctxReturning({ status: 0, stdout: "SHOULD NOT RUN", stderr: "" }));
  assert.equal(r.ok, true);
  assert.match(String(r.note), /no deployed url/i);
});

test("a curl spawn error fails closed", () => {
  const r = checkHealth(deployed, ctxReturning({ status: null, stdout: "", stderr: "", error: "curl not found" }));
  assert.equal(r.ok, false);
  assert.match(String(r.error), /curl not found|could not/i);
});

test("the tool handler fails closed on an unknown project", () => {
  const r = projectHealth.handler({ name: "nope" }, ctxReturning({ status: 0, stdout: "", stderr: "" }));
  assert.equal((r as { ok: boolean }).ok, false);
});
