import { test } from "node:test";
import assert from "node:assert/strict";
import { createGeminiTransport } from "../src/gemini.ts";
import type { CreateMessageRequest, Message, ToolUseBlock } from "../src/types.ts";

const noSleep = async () => {};

function stubFetch(responses: unknown[]) {
  let i = 0;
  const bodies: Record<string, unknown>[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const urls: string[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    urls.push(String(url));
    inits.push(init);
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    if (i >= responses.length) throw new Error("out of responses");
    return new Response(JSON.stringify(responses[i++]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fn, bodies, inits, urls };
}

const tools = [
  {
    name: "colima_disk",
    description: "disk",
    input_schema: { type: "object" as const, properties: { action: { type: "string", enum: ["status"] } }, required: ["action"] },
  },
];

test("request: translates system/tools/messages to Gemini shape; uppercases schema; x-goog-api-key; model in url", async () => {
  const s = stubFetch([{ candidates: [{ content: { role: "model", parts: [{ text: "hi" }] }, finishReason: "STOP" }] }]);
  const t = createGeminiTransport({ apiKey: "g-key", model: "gemini-2.5-flash", fetchImpl: s.fn, sleep: noSleep });
  const req: CreateMessageRequest = { model: "gemini-2.5-flash", max_tokens: 64, system: "be brief", tools, messages: [{ role: "user", content: "hello" }] };
  const res = await t.createMessage(req);
  assert.equal(res.stop_reason, "end_turn");
  assert.equal(res.content[0]!.type, "text");

  assert.match(s.urls[0]!, /models\/gemini-2\.5-flash:generateContent$/);
  assert.equal((s.inits[0]!.headers as Record<string, string>)["x-goog-api-key"], "g-key");

  const b = s.bodies[0]! as any;
  assert.equal(b.systemInstruction.parts[0].text, "be brief");
  assert.equal(b.generationConfig.maxOutputTokens, 64);
  assert.equal(b.contents[0].role, "user");
  assert.equal(b.contents[0].parts[0].text, "hello");
  const fd = b.tools[0].functionDeclarations[0];
  assert.equal(fd.name, "colima_disk");
  assert.equal(fd.parameters.type, "OBJECT");
  assert.equal(fd.parameters.properties.action.type, "STRING");
  assert.deepEqual(fd.parameters.properties.action.enum, ["status"]);
});

test("response: functionCall → tool_use block + stop_reason tool_use", async () => {
  const s = stubFetch([{ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "colima_disk", args: { action: "status" } } }] } }] }]);
  const t = createGeminiTransport({ apiKey: "k", model: "gemini-2.5-flash", fetchImpl: s.fn, sleep: noSleep });
  const res = await t.createMessage({ model: "x", max_tokens: 10, tools, messages: [{ role: "user", content: "disk?" }] });
  assert.equal(res.stop_reason, "tool_use");
  const blk = res.content[0] as ToolUseBlock;
  assert.equal(blk.type, "tool_use");
  assert.equal(blk.name, "colima_disk");
  assert.deepEqual(blk.input, { action: "status" });
});

test("round-trip: assistant tool_use + user tool_result → model functionCall + user functionResponse (name resolved by id)", async () => {
  const s = stubFetch([{ candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" }] }]);
  const t = createGeminiTransport({ apiKey: "k", model: "gemini-2.5-flash", fetchImpl: s.fn, sleep: noSleep });
  const messages: Message[] = [
    { role: "user", content: "disk?" },
    { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "colima_disk", input: { action: "status" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: JSON.stringify({ ok: true, decision: "skip" }) }] },
  ];
  await t.createMessage({ model: "x", max_tokens: 10, tools, messages });
  const b = s.bodies[0]! as any;
  assert.equal(b.contents[1].role, "model");
  assert.equal(b.contents[1].parts[0].functionCall.name, "colima_disk");
  assert.deepEqual(b.contents[1].parts[0].functionCall.args, { action: "status" });
  assert.equal(b.contents[2].role, "user");
  const fr = b.contents[2].parts[0].functionResponse;
  assert.equal(fr.name, "colima_disk");
  assert.deepEqual(fr.response, { ok: true, decision: "skip" });
});

test("honors req.model (the router's pick) over the configured default in the URL", async () => {
  const s = stubFetch([{ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] }]);
  const t = createGeminiTransport({ apiKey: "k", model: "gemini-2.5-flash", fetchImpl: s.fn, sleep: noSleep });
  await t.createMessage({ model: "gemini-2.5-pro", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
  assert.match(s.urls[0]!, /models\/gemini-2\.5-pro:generateContent$/);
});

test("MAX_TOKENS finishReason → stop_reason max_tokens", async () => {
  const s = stubFetch([{ candidates: [{ content: { role: "model", parts: [{ text: "partial" }] }, finishReason: "MAX_TOKENS" }] }]);
  const t = createGeminiTransport({ apiKey: "k", model: "gemini-2.5-flash", fetchImpl: s.fn, sleep: noSleep });
  const res = await t.createMessage({ model: "x", max_tokens: 1, messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.stop_reason, "max_tokens");
});
