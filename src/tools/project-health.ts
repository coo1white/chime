import type { Capability, HandlerContext, JsonSchema, ToolResultPayload } from "../types.ts";
import { findProject, loadProjects, type Project } from "../projects.ts";

// Read-only reachability check: curl the project's deployed health URL and report
// up/down + the HTTP code. `-f` makes curl exit non-zero on >= 400, and
// `-w %{http_code}` prints the code; a connect failure prints nothing, read as 000.

const TIMEOUT_MS = 12_000;

export function checkHealth(p: Project, ctx: HandlerContext): ToolResultPayload {
  if (!p.deployedUrl) {
    return { ok: true, name: p.name, note: "no deployed url — nothing to check" };
  }
  const url = p.deployedUrl;
  const r = ctx.runCommand("curl", ["-fsS", "-m", "8", "-o", "/dev/null", "-w", "%{http_code}", url], {
    timeoutMs: TIMEOUT_MS,
  });

  if (r.error) {
    return { ok: false, name: p.name, url, error: `could not run curl: ${r.error}` };
  }
  const httpCode = r.stdout.trim() || "000";
  return { ok: true, name: p.name, url, up: r.status === 0, httpCode };
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
  return checkHealth(p, ctx);
}

export const projectHealth: Capability = {
  name: "project_health",
  description:
    "Check whether a project's deployed site is up by curling its health URL. Call this when the user asks 'is X up/live/healthy' or 'is my site responding'. Read-only: it only makes one GET and reports the HTTP code. Projects with no deployed URL return a note.",
  inputSchema,
  handler,
};
