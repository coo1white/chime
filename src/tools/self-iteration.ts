import { existsSync } from "node:fs";
import type { Capability, HandlerContext, JsonSchema, ToolResultPayload } from "../types.ts";
import { findProject, loadProjects, projectPath } from "../projects.ts";

function git(ctx: HandlerContext, path: string, args: string[]): { ok: boolean; out: string } {
  const r = ctx.runCommand("git", ["-C", path, ...args], { timeoutMs: 15_000 });
  if (r.status !== 0 || r.error) return { ok: false, out: (r.stderr || r.error || "").trim() };
  return { ok: true, out: r.stdout.trim() };
}

function lines(text: string): string[] {
  return text.split("\n").filter((s) => s.trim() !== "");
}

function classify(files: string[]): { staged: string[]; unstaged: string[]; untracked: string[] } {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  for (const row of files) {
    const xy = row.slice(0, 2);
    const file = row.slice(3);
    if (xy === "??") {
      untracked.push(file);
      continue;
    }
    if (xy[0] !== " ") staged.push(file);
    if (xy[1] !== " ") unstaged.push(file);
  }
  return { staged, unstaged, untracked };
}

const inputSchema: JsonSchema = {
  type: "object",
  properties: {
    name: { type: "string", description: "project name from ~/.chime/projects.json" },
  },
  required: ["name"],
  additionalProperties: false,
};

function handler(input: Record<string, unknown>, ctx: HandlerContext): ToolResultPayload {
  const name = String(input.name ?? "");
  if (!name) return { ok: false, error: "name is required" };
  const p = findProject(name, loadProjects(ctx.home));
  if (!p) return { ok: false, name, error: `unknown project: ${name}` };
  const path = projectPath(p, ctx.home);
  if (!existsSync(path)) return { ok: false, name, error: "path not found" };

  const branch = git(ctx, path, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = git(ctx, path, ["status", "--porcelain"]);
  const head = git(ctx, path, ["log", "-1", "--pretty=%h %s"]);
  if (!status.ok) return { ok: false, name, error: status.out || "git status failed" };

  const changedFiles = lines(status.out);
  const c = classify(changedFiles);
  const dirty = changedFiles.length > 0;
  const findings = dirty
    ? [
        "worktree is dirty; separate current-task files from unrelated changes before any PR",
        ...(c.staged.length ? ["staged changes exist; verify cached diff before commit"] : []),
        ...(c.unstaged.length || c.untracked.length ? ["unstaged or untracked changes exist; decide whether they belong to this task"] : []),
      ]
    : ["worktree is clean; safe to start a focused change"];

  return {
    ok: true,
    name,
    branch: branch.ok ? branch.out : "unknown",
    head: head.ok ? head.out : "unknown",
    dirty,
    changedFiles,
    staged: c.staged,
    unstaged: c.unstaged,
    untracked: c.untracked,
    loop: [
      "look: inspect status and diff before acting",
      "isolate: stage only files for the current task",
      "verify: run the smallest relevant gate and record evidence",
      "reflect: name one thing to keep and one thing to change next time",
    ],
    keep: ["small PRs", "explicit verification", "separate unrelated dirty files"],
    improve: dirty ? ["clear or split dirty work before opening another PR"] : ["keep the next change scoped to one reason"],
    nextSteps: dirty ? ["git diff --stat", "git diff --cached --stat", "stage only the files for one PR"] : ["start a feature branch before editing"],
    findings,
  };
}

export const selfIteration: Capability = {
  name: "self_iteration",
  description:
    "Run Chime's read-only self-iteration mode for one project: inspect git state, classify staged/unstaged/untracked files, and return a compact loop of what to keep, what to improve, and exact next steps. Call this when the user asks to self-iterate, reflect, improve the workflow, or explain what should change next time.",
  inputSchema,
  handler,
};
