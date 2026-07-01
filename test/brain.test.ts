import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurn, type BrainConfig } from "../src/brain.ts";
import type {
  AnthropicResponse,
  Capability,
  CreateMessageRequest,
  HandlerContext,
  Message,
  Transport,
  ToolResultBlock,
} from "../src/types.ts";

const ctx: HandlerContext = {
  runCommand: () => ({ status: 0, stdout: "", stderr: "" }),
  env: {},
  now: () => new Date(0),
  home: "/tmp",
};

const reg: Capability[] = [
  { name: "get_x", description: "x", inputSchema: { type: "object", properties: {} }, handler: () => ({ ok: true, x: 7 }) },
  { name: "get_y", description: "y", inputSchema: { type: "object", properties: {} }, handler: () => ({ ok: true, y: 9 }) },
];

const config: BrainConfig = { model: "m", maxTokens: 100, system: "sys", maxIterations: 5 };

// A transport that yields scripted responses in order, then repeats the last one
// forever (so a tool_use-only script drives the max-iteration guard).
function scripted(responses: AnthropicResponse[]): Transport & { calls: CreateMessageRequest[] } {
  const calls: CreateMessageRequest[] = [];
  let i = 0;
  return {
    calls,
    async createMessage(req: CreateMessageRequest): Promise<AnthropicResponse> {
      calls.push(req);
      const r = responses[Math.min(i, responses.length - 1)]!;
      i++;
      return r;
    },
  };
}

function toolUse(uses: { id: string; name: string }[]): AnthropicResponse {
  return {
    role: "assistant",
    stop_reason: "tool_use",
    content: uses.map((u) => ({ type: "tool_use", id: u.id, name: u.name, input: {} })),
  };
}

function endTurn(text: string): AnthropicResponse {
  return { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] };
}

test("single tool_use then end_turn: handler runs, history well-formed, reply text returned", async () => {
  const transport = scripted([toolUse([{ id: "t1", name: "get_x" }]), endTurn("x is 7")]);
  const start: Message[] = [{ role: "user", content: "how's x?" }];
  const res = await runTurn(start, transport, reg, config, ctx);

  assert.equal(res.reply, "x is 7");
  assert.equal(res.stopReason, "end_turn");
  assert.equal(transport.calls.length, 2);
  // request carried system + tools + messages
  assert.equal(transport.calls[0]!.system, "sys");
  assert.equal(transport.calls[0]!.tools?.length, 2);
  // history: user → assistant(tool_use) → user(tool_result) → assistant(text)
  assert.equal(res.history.length, 4);
  assert.equal(res.history[1]!.role, "assistant");
  const trMsg = res.history[2]!;
  assert.equal(trMsg.role, "user");
  const blocks = trMsg.content as unknown as ToolResultBlock[];
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.type, "tool_result");
  assert.equal(blocks[0]!.tool_use_id, "t1");
  assert.deepEqual(JSON.parse(blocks[0]!.content), { ok: true, x: 7 });
});

test("two tool_use blocks in one turn → one user message with two tool_results", async () => {
  const transport = scripted([
    toolUse([{ id: "a", name: "get_x" }, { id: "b", name: "get_y" }]),
    endTurn("both done"),
  ]);
  const res = await runTurn([{ role: "user", content: "x and y?" }], transport, reg, config, ctx);
  assert.equal(res.reply, "both done");
  const trMsg = res.history[2]!;
  const blocks = trMsg.content as unknown as ToolResultBlock[];
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((b) => b.tool_use_id).sort(), ["a", "b"]);
});

test("never-ending tool_use trips the max-iteration guard (bounded, graceful)", async () => {
  const transport = scripted([toolUse([{ id: "t", name: "get_x" }])]); // always tool_use
  const res = await runTurn([{ role: "user", content: "loop?" }], transport, reg, { ...config, maxIterations: 3 }, ctx);
  assert.equal(transport.calls.length, 3, "must be bounded by maxIterations");
  assert.equal(res.stopReason, "max_iterations");
  assert.match(res.reply, /tool-call limit/);
});
