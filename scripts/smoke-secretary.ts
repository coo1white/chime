// No-network smoke: prove the secretary tools work end-to-end through the real
// dispatch path (registry -> handler -> structured tool_result) with NO API key.
// Run: node scripts/smoke-secretary.ts
import { executeToolUse } from "../src/dispatch.ts";
import { BUILTIN_CAPABILITIES } from "../src/registry.ts";
import { realHandlerContext } from "../src/backend.ts";
import type { ToolUseBlock } from "../src/types.ts";

const ctx = realHandlerContext();

function call(name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const block: ToolUseBlock = { type: "tool_use", id: `t_${name}`, name, input };
  return executeToolUse(block, BUILTIN_CAPABILITIES, ctx).then((r) => JSON.parse(r.content) as Record<string, unknown>);
}

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    process.stderr.write(`smoke-secretary: FAIL — ${msg}\n`);
    process.exit(1);
  }
}

// 1) projects/list — reads the user's private registry (~/.chime/projects.json).
const list = await call("projects", { action: "list" });
assert(list.ok === true, "projects/list ok");
const rows = list.projects as { name: string }[];
process.stdout.write(`smoke-secretary: projects/list -> ${rows.length} repos${rows.length === 0 ? " (no ~/.chime/projects.json yet)" : ""}\n`);

// 2) project_status all — live git + version, read-only. One card per registry row.
const status = await call("project_status", { name: "all" });
assert(status.ok === true, "project_status/all ok");
const cards = status.projects as { name: string; version?: string }[];
assert(cards.length === rows.length, "one status card per project");
process.stdout.write(`smoke-secretary: project_status/all -> ${cards.length} cards\n`);

// 3) project_doctor all — a read-only health board, one graded card per repo.
const board = await call("project_doctor", { name: "all" });
assert(board.ok === true, "project_doctor/all ok");
const scored = board.projects as { name: string; score?: number; grade?: string }[];
assert(scored.length === rows.length, "one doctor card per project");
process.stdout.write(`smoke-secretary: project_doctor/all -> ${scored.length} graded cards\n`);

// 4) an unknown tool still fails closed (dispatch never throws).
const bad = await call("no_such_tool", {});
assert(bad.ok === false, "unknown tool fails closed");

process.stdout.write("smoke-secretary: PASS (no network used)\n");
