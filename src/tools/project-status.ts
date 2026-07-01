import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Capability, HandlerContext, JsonSchema, ToolResultPayload } from "../types.ts";
import { findProject, loadProjects, parseVersion, projectPath, type Project } from "../projects.ts";

// Live, read-only status: current branch, dirty?, HEAD, and the version read from
// the file the registry names. git runs via `git -C <path>` so no cwd is needed;
// every read fails soft — a status card must never throw.

function git(ctx: HandlerContext, path: string, args: string[]): { ok: boolean; out: string } {
  const r = ctx.runCommand("git", ["-C", path, ...args], { timeoutMs: 15_000 });
  if (r.status !== 0 || r.error) return { ok: false, out: (r.stderr || r.error || "").trim() };
  return { ok: true, out: r.stdout.trim() };
}

function readVersion(p: Project, home: string): string | undefined {
  if (!p.versionFile || !p.versionKind) return undefined;
  const file = join(projectPath(p, home), p.versionFile);
  if (!existsSync(file)) return undefined;
  try {
    return parseVersion(p.versionKind, readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function statusOne(p: Project, ctx: HandlerContext): Record<string, unknown> {
  const path = projectPath(p, ctx.home);
  if (!existsSync(path)) {
    return { name: p.name, gitError: "path not found", version: undefined };
  }
  const branch = git(ctx, path, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const porcelain = git(ctx, path, ["status", "--porcelain"]);
  const head = git(ctx, path, ["log", "-1", "--pretty=%h %s"]);
  const version = readVersion(p, ctx.home);

  if (!branch.ok && !head.ok) {
    // git itself is unhappy (not a repo / git missing) — note it, keep the version.
    return { name: p.name, gitError: branch.out || "git unavailable", version };
  }
  return {
    name: p.name,
    branch: branch.ok ? branch.out : "unknown",
    dirty: porcelain.ok ? porcelain.out !== "" : undefined,
    head: head.ok ? head.out : "unknown",
    version,
  };
}

const inputSchema: JsonSchema = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "a project name (e.g. web-app), or 'all' for every project",
    },
  },
  required: ["name"],
  additionalProperties: false,
};

function handler(input: Record<string, unknown>, ctx: HandlerContext): ToolResultPayload {
  const name = String(input.name ?? "");
  if (!name) return { ok: false, error: "name is required (a project name or 'all')" };
  const reg = loadProjects(ctx.home);

  if (name === "all") {
    return { ok: true, name, projects: reg.map((p) => statusOne(p, ctx)) };
  }

  const p = findProject(name, reg);
  if (!p) return { ok: false, name, error: `unknown project: ${name}` };
  return { ok: true, ...statusOne(p, ctx) };
}

export const projectStatus: Capability = {
  name: "project_status",
  description:
    "Read the live git state and current version of one project (or 'all'). Call this when the user asks 'what's the status of X', 'is X dirty / what branch', 'what version is X', or wants a quick board across all repos. Read-only: it runs git status/log and reads the version file. It never changes anything.",
  inputSchema,
  handler,
};
