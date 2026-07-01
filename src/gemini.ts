import type {
  AnthropicResponse,
  ContentBlock,
  CreateMessageRequest,
  Message,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  Transport,
} from "./types.ts";
import { postJson } from "./http.ts";

export interface GeminiTransportOptions {
  apiKey: string;
  model: string;
  baseUrl?: string; // default https://generativelanguage.googleapis.com/v1beta
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

// --- Gemini wire shapes (only what we use) ---
interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}
interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}
export interface GeminiResponse {
  candidates?: Array<{ content?: { role?: string; parts?: GeminiPart[] }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  modelVersion?: string;
}

const DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";

// JSON Schema (lowercase types) → Gemini Schema (UPPERCASE types). Drops fields
// Gemini doesn't accept (additionalProperties). Recurses into properties/items.
function toGeminiSchema(schema: unknown): Record<string, unknown> {
  if (schema === null || typeof schema !== "object") return {};
  const s = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof s.type === "string") out.type = s.type.toUpperCase();
  if (typeof s.description === "string") out.description = s.description;
  if (Array.isArray(s.enum)) out.enum = s.enum;
  if (Array.isArray(s.required)) out.required = s.required;
  if (s.properties && typeof s.properties === "object") {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s.properties as Record<string, unknown>)) {
      props[k] = toGeminiSchema(v);
    }
    out.properties = props;
  }
  if (s.items) out.items = toGeminiSchema(s.items);
  return out;
}

function isTextBlock(b: ContentBlock): b is TextBlock {
  return b.type === "text";
}
function isToolUseBlock(b: ContentBlock): b is ToolUseBlock {
  return b.type === "tool_use";
}
function isToolResultBlock(b: ContentBlock): b is ToolResultBlock {
  return b.type === "tool_result";
}

// Anthropic keys tool results by tool_use_id; Gemini keys functionResponse by name.
// Build id→name from every assistant tool_use block so results can be translated.
function idToName(messages: Message[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (isToolUseBlock(b)) map.set(b.id, b.name);
      }
    }
  }
  return map;
}

function parseObject(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { result: v };
  } catch {
    return { result: s };
  }
}

function toGeminiContents(messages: Message[]): GeminiContent[] {
  const names = idToName(messages);
  const out: GeminiContent[] = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      out.push({ role: msg.role === "assistant" ? "model" : "user", parts: [{ text: msg.content }] });
      continue;
    }
    if (msg.role === "assistant") {
      const parts: GeminiPart[] = [];
      for (const b of msg.content) {
        if (isTextBlock(b)) parts.push({ text: b.text });
        else if (isToolUseBlock(b)) parts.push({ functionCall: { name: b.name, args: b.input ?? {} } });
      }
      if (parts.length) out.push({ role: "model", parts });
    } else {
      const parts: GeminiPart[] = [];
      for (const b of msg.content) {
        if (isToolResultBlock(b)) {
          parts.push({
            functionResponse: { name: names.get(b.tool_use_id) ?? b.tool_use_id, response: parseObject(b.content) },
          });
        } else if (isTextBlock(b)) {
          parts.push({ text: b.text });
        }
      }
      if (parts.length) out.push({ role: "user", parts });
    }
  }
  return out;
}

// Build the Gemini generateContent request body from a provider-agnostic request.
// Shared by the AI-Studio (gemini.ts) and Vertex (vertex.ts) transports — only the
// URL and auth header differ between them.
export function buildGeminiRequestBody(req: CreateMessageRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    contents: toGeminiContents(req.messages),
    generationConfig: { maxOutputTokens: req.max_tokens },
  };
  if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
  if (req.tools && req.tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: toGeminiSchema(t.input_schema),
        })),
      },
    ];
  }
  return body;
}

export function fromGemini(data: GeminiResponse, model: string): AnthropicResponse {
  const cand = data.candidates?.[0];
  const parts = cand?.content?.parts ?? [];
  const content: ContentBlock[] = [];
  let hasCall = false;
  parts.forEach((p, i) => {
    if (typeof p.text === "string") {
      content.push({ type: "text", text: p.text });
    } else if (p.functionCall) {
      hasCall = true;
      content.push({
        type: "tool_use",
        id: `gemini-${i}-${p.functionCall.name}`,
        name: p.functionCall.name,
        input: p.functionCall.args ?? {},
      });
    }
  });

  let stop: string;
  if (hasCall) {
    stop = "tool_use";
  } else {
    const fr = cand?.finishReason;
    if (fr === "MAX_TOKENS") stop = "max_tokens";
    else if (fr === "SAFETY" || fr === "BLOCKED_REASON" || data.promptFeedback?.blockReason) stop = "refusal";
    else stop = "end_turn";
  }
  if (content.length === 0 && stop === "refusal") {
    content.push({ type: "text", text: "(the model declined to respond)" });
  }
  return { role: "assistant", content, stop_reason: stop, model: data.modelVersion ?? model };
}

// A Transport that speaks Gemini generateContent but presents the same interface as
// the Anthropic client, so brain.ts / dispatch / the registry stay provider-agnostic.
export function createGeminiTransport(opts: GeminiTransportOptions): Transport {
  const base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
  return {
    async createMessage(req: CreateMessageRequest): Promise<AnthropicResponse> {
      // Use the per-request model (the router's pick) over the configured default.
      const model = req.model || opts.model;
      const url = `${base}/models/${model}:generateContent`;
      const data = await postJson<GeminiResponse>({
        url,
        headers: { "content-type": "application/json", "x-goog-api-key": opts.apiKey },
        body: buildGeminiRequestBody(req),
        fetchImpl: opts.fetchImpl,
        maxRetries: opts.maxRetries,
        sleep: opts.sleep,
      });
      return fromGemini(data, model);
    },
  };
}
