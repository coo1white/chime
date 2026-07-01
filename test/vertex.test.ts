import { test } from "node:test";
import assert from "node:assert/strict";
import { createVertexTransport, tokenFrom, type GcloudRunner } from "../src/vertex.ts";
import type { CreateMessageRequest } from "../src/types.ts";

const req: CreateMessageRequest = {
  model: "gemini-2.5-pro",
  max_tokens: 256,
  system: "be brief",
  tools: [
    {
      name: "colima_disk",
      description: "disk tool",
      input_schema: { type: "object", properties: { action: { type: "string" } }, required: ["action"] },
    },
  ],
  messages: [{ role: "user", content: "hi" }],
};

function fakeFetch(capture: { url?: string; auth?: string; body?: unknown }) {
  return async (url: string, init: RequestInit): Promise<Response> => {
    capture.url = url;
    capture.auth = (init.headers as Record<string, string>).authorization;
    capture.body = JSON.parse(init.body as string);
    const data = {
      candidates: [{ content: { role: "model", parts: [{ text: "hello" }] }, finishReason: "STOP" }],
      modelVersion: "gemini-2.5-pro",
    };
    return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
  };
}

test("tokenFrom prefers ADC, falls back to the user login, else null", () => {
  // ADC works → its token, no user-login attempt
  const adc: GcloudRunner = (args) =>
    args.includes("application-default") ? { status: 0, stdout: "ADC\n" } : { status: 0, stdout: "USER\n" };
  assert.equal(tokenFrom(adc), "ADC");

  // ADC fails → fall back to the plain user login
  const userOnly: GcloudRunner = (args) =>
    args.includes("application-default") ? { status: 1, stdout: "" } : { status: 0, stdout: "USER\n" };
  assert.equal(tokenFrom(userOnly), "USER");

  // neither works → null (caller signs in / errors)
  const none: GcloudRunner = () => ({ status: 1, stdout: "" });
  assert.equal(tokenFrom(none), null);
});

test("builds the Vertex URL from project/location/model and sends a Bearer token", async () => {
  const cap: { url?: string; auth?: string; body?: unknown } = {};
  const t = createVertexTransport({
    project: "demo-project",
    location: "us-central1",
    model: "gemini-2.5-flash",
    getAccessToken: () => "TOKEN123",
    fetchImpl: fakeFetch(cap) as unknown as typeof fetch,
  });
  const res = await t.createMessage(req);
  assert.equal(
    cap.url,
    "https://us-central1-aiplatform.googleapis.com/v1/projects/demo-project/locations/us-central1/publishers/google/models/gemini-2.5-pro:generateContent",
  );
  assert.equal(cap.auth, "Bearer TOKEN123");
  // body is Gemini-shaped (systemInstruction + functionDeclarations)
  const body = cap.body as Record<string, any>;
  assert.ok(body.systemInstruction);
  assert.equal(body.tools[0].functionDeclarations[0].name, "colima_disk");
  // response mapped back to the provider-agnostic shape
  assert.equal(res.content[0]!.type, "text");
  assert.equal(res.stop_reason, "end_turn");
});

test("uses the per-request model, falling back to the default", async () => {
  const cap: { url?: string } = {};
  const t = createVertexTransport({
    project: "p",
    location: "us-east1",
    model: "gemini-2.5-flash",
    getAccessToken: () => "T",
    fetchImpl: fakeFetch(cap) as unknown as typeof fetch,
  });
  await t.createMessage({ ...req, model: "" }); // no per-request model -> default
  assert.match(cap.url!, /models\/gemini-2\.5-flash:generateContent/);
});

test("caches the token within the window (one gcloud call for two turns)", async () => {
  let calls = 0;
  let clock = 0;
  const cap: { url?: string } = {};
  const t = createVertexTransport({
    project: "p",
    location: "us-central1",
    model: "gemini-2.5-flash",
    getAccessToken: () => {
      calls++;
      return `T${calls}`;
    },
    now: () => clock,
    fetchImpl: fakeFetch(cap) as unknown as typeof fetch,
  });
  await t.createMessage(req);
  clock += 60_000; // 1 min later
  await t.createMessage(req);
  assert.equal(calls, 1, "token reused within the window");
  clock += 60 * 60_000; // an hour later
  await t.createMessage(req);
  assert.equal(calls, 2, "token refreshed after it goes stale");
});
