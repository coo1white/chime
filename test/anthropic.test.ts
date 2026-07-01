import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttpTransport } from "../src/anthropic.ts";
import { ApiError } from "../src/types.ts";
import type { CreateMessageRequest } from "../src/types.ts";

const req: CreateMessageRequest = {
  model: "m",
  max_tokens: 10,
  messages: [{ role: "user", content: "hi" }],
};
const noSleep = async () => {};

function stubFetch(responses: Response[]) {
  let i = 0;
  const inits: (RequestInit | undefined)[] = [];
  const fn = (async (_url: string | URL, init?: RequestInit) => {
    inits.push(init);
    if (i >= responses.length) throw new Error("stubFetch: out of responses");
    return responses[i++]!;
  }) as unknown as typeof fetch;
  return { fn, inits, calls: () => i };
}

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("success: returns parsed response and sends the three required headers", async () => {
  const fake = { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "hi" }] };
  const s = stubFetch([okResponse(fake)]);
  const t = createHttpTransport({
    apiKey: "sk-x",
    baseUrl: "https://x/v1/messages",
    anthropicVersion: "2023-06-01",
    fetchImpl: s.fn,
    sleep: noSleep,
  });
  const res = await t.createMessage(req);
  assert.equal(res.stop_reason, "end_turn");
  assert.equal(s.calls(), 1);
  const headers = s.inits[0]!.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], "sk-x");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(headers["content-type"], "application/json");
});

test("429 then 200: retries and succeeds", async () => {
  const fake = { role: "assistant", stop_reason: "end_turn", content: [] };
  const s = stubFetch([new Response("{}", { status: 429 }), okResponse(fake)]);
  const t = createHttpTransport({ apiKey: "k", baseUrl: "u", anthropicVersion: "v", fetchImpl: s.fn, sleep: noSleep, maxRetries: 2 });
  const res = await t.createMessage(req);
  assert.equal(res.stop_reason, "end_turn");
  assert.equal(s.calls(), 2);
});

test("400: throws ApiError immediately with the API message, no retry", async () => {
  const s = stubFetch([new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 })]);
  const t = createHttpTransport({ apiKey: "k", baseUrl: "u", anthropicVersion: "v", fetchImpl: s.fn, sleep: noSleep, maxRetries: 2 });
  await assert.rejects(
    () => t.createMessage(req),
    (e: unknown) => e instanceof ApiError && e.status === 400 && /bad request/.test(e.message),
  );
  assert.equal(s.calls(), 1);
});

test("500: retries then throws ApiError after maxRetries+1 tries", async () => {
  const s = stubFetch([
    new Response("e", { status: 500 }),
    new Response("e", { status: 500 }),
    new Response("e", { status: 500 }),
  ]);
  const t = createHttpTransport({ apiKey: "k", baseUrl: "u", anthropicVersion: "v", fetchImpl: s.fn, sleep: noSleep, maxRetries: 2 });
  await assert.rejects(() => t.createMessage(req), ApiError);
  assert.equal(s.calls(), 3);
});
