import type { Capability, HandlerContext, JsonSchema, ToolResultPayload } from "../types.ts";
import { checkPath, findProject, loadProjects, type Project } from "../projects.ts";

// Run a project's OWN fast, non-mutating gate (lint-check / typecheck / static
// analysis / doctor) in the repo. A non-zero exit is a real FAIL, not a tool
// error (ok stays true). The heavy suite is never run here — it is surfaced as
// the fullGate next-step string for the user to run.

const TIMEOUT_MS = 120_000;
const TAIL_LINES = 20;

function tail(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .slice(-TAIL_LINES);
}

export function checkProject(p: Project, ctx: HandlerContext): ToolResultPayload {
  if (!p.check || p.check.length === 0) {
    return { ok: true, name: p.name, note: "no check command for this project", fullGate: p.fullGate };
  }
  const [cmd, ...args] = p.check;
  const cwd = checkPath(p, ctx.home);
  const r = ctx.runCommand(cmd!, args, { cwd, timeoutMs: TIMEOUT_MS });

  if (r.error) {
    // spawn error or timeout — the gate did not run to a verdict.
    return {
      ok: false,
      name: p.name,
      error: `could not run check: ${r.error}`,
      cmd: p.check.join(" "),
      fullGate: p.fullGate,
    };
  }

  const combined = `${r.stdout}\n${r.stderr}`;
  return {
    ok: true,
    name: p.name,
    pass: r.status === 0,
    exitCode: r.status,
    cmd: p.check.join(" "),
    tail: tail(combined),
    fullGate: p.fullGate,
  };
}

const inputSchema: JsonSchema = {
  type: "object",
  properties: {
    name: { type: "string", description: "the project name (e.g. web-app)" },
  },
  required: ["name"],
  additionalProperties: false,
};

function handler(input: Record<string, unknown>, ctx: HandlerContext): ToolResultPayload {
  const name = String(input.name ?? "");
  const p = findProject(name, loadProjects(ctx.home));
  if (!p) return { ok: false, name, error: `unknown project: ${name}` };
  return checkProject(p, ctx);
}

export const projectCheck: Capability = {
  name: "project_check",
  description:
    "Run one project's own fast, non-mutating gate (lint-check / typecheck / static analysis) and report PASS or FAIL with a short tail. Call this when the user asks 'is X clean/green', 'does X still typecheck', or before they commit. Read-only: it never builds, writes, or changes state; the heavy build/test suite is returned as a next-step command, not run.",
  inputSchema,
  handler,
};
