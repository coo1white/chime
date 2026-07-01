import { test } from "node:test";
import assert from "node:assert/strict";
import { executeToolUse } from "../src/dispatch.ts";
import type { Capability, HandlerContext, ToolUseBlock } from "../src/types.ts";

const ctx: HandlerContext = {
  runCommand: () => ({ status: 0, stdout: "", stderr: "" }),
  env: {},
  now: () => new Date(0),
  home: "/tmp/home",
};

const reg: Capability[] = [
  {
    name: "ok_tool",
    description: "ok",
    inputSchema: { type: "object", properties: {} },
    handler: (input) => ({ ok: true, echoed: input.x }),
  },
  {
    name: "fail_tool",
    description: "fail",
    inputSchema: { type: "object", properties: {} },
    handler: () => ({ ok: false, reason: "nope" }),
  },
  {
    name: "throw_tool",
    description: "throw",
    inputSchema: { type: "object", properties: {} },
    handler: () => {
      throw new Error("boom");
    },
  },
];

function block(name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: "tool_use", id: "toolu_1", name, input };
}

test("known tool: runs handler, echoes tool_use_id, not is_error", async () => {
  const r = await executeToolUse(block("ok_tool", { x: 42 }), reg, ctx);
  assert.equal(r.type, "tool_result");
  assert.equal(r.tool_use_id, "toolu_1");
  assert.equal(r.is_error, false);
  assert.deepEqual(JSON.parse(r.content), { ok: true, echoed: 42 });
});

test("unknown tool: fail-closed is_error, ok:false (never throws)", async () => {
  const r = await executeToolUse(block("nope"), reg, ctx);
  assert.equal(r.is_error, true);
  const payload = JSON.parse(r.content);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /unknown tool: nope/);
});

test("handler returning ok:false maps to is_error", async () => {
  const r = await executeToolUse(block("fail_tool"), reg, ctx);
  assert.equal(r.is_error, true);
  assert.deepEqual(JSON.parse(r.content), { ok: false, reason: "nope" });
});

test("handler throwing maps to is_error with message (loop-safe)", async () => {
  const r = await executeToolUse(block("throw_tool"), reg, ctx);
  assert.equal(r.is_error, true);
  const payload = JSON.parse(r.content);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /boom/);
});
