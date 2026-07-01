import type { Capability, HandlerContext, JsonSchema, ToolResultPayload } from "../types.ts";
import { findProject, loadProjects, type Project } from "../projects.ts";

// A pure tool: it only reads the registry, so Chime can "know" every repo at a
// glance. Live git/version facts belong to project_status, not here.

const inputSchema: JsonSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["list", "brief"],
      description: "list = every project with a one-line summary + mantra; brief = the full card for one project",
    },
    name: { type: "string", description: "brief only: the project name (e.g. web-app)" },
  },
  required: ["action"],
  additionalProperties: false,
};

function card(p: Project): Record<string, unknown> {
  return {
    name: p.name,
    kind: p.kind,
    summary: p.summary,
    mantra: p.mantra,
    path: `~/${p.path}`,
    remotes: p.remotes,
    deployedUrl: p.deployedUrl,
    versionSource: p.versionFile ? `${p.versionFile} (${p.versionKind})` : "n/a",
    check: p.check ? p.check.join(" ") : "n/a",
    fullGate: p.fullGate,
  };
}

function handler(input: Record<string, unknown>, ctx: HandlerContext): ToolResultPayload {
  const action = String(input.action ?? "");
  const reg = loadProjects(ctx.home);

  if (action === "list") {
    if (reg.length === 0) {
      return { ok: true, action, count: 0, projects: [], note: "no projects yet — add ~/.chime/projects.json (see projects.example.json)" };
    }
    return {
      ok: true,
      action,
      count: reg.length,
      projects: reg.map((p) => ({ name: p.name, kind: p.kind, summary: p.summary, mantra: p.mantra })),
    };
  }

  if (action === "brief") {
    const name = typeof input.name === "string" ? input.name : "";
    if (!name) return { ok: false, action, error: "brief needs a project name" };
    const p = findProject(name, reg);
    if (!p) return { ok: false, action, error: `unknown project: ${name}` };
    return { ok: true, action, ...card(p) };
  }

  return { ok: false, action, error: `unknown action: ${action} (expected list|brief)` };
}

export const projects: Capability = {
  name: "projects",
  description:
    "List the user's projects or get one project's card. Call this when the user asks 'what projects do I have', about a project's purpose/stack/mantra/where it lives, or needs the exact check/build command for a repo. Read-only: it reads Chime's project registry. For live git state or the current version, use project_status.",
  inputSchema,
  handler,
};
