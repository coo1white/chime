import { spawnSync } from "node:child_process";
import type { AnthropicResponse, CreateMessageRequest, Transport } from "./types.ts";
import { ApiError } from "./types.ts";
import { postJson } from "./http.ts";
import { buildGeminiRequestBody, fromGemini, type GeminiResponse } from "./gemini.ts";

// Vertex AI Gemini transport. Same generateContent body/response as the AI-Studio
// Gemini backend — only the URL and auth differ: a per-project/location endpoint and
// a Bearer access token from gcloud Application Default Credentials (so the user logs
// in once with `chime login` and never pastes a key).

export interface VertexTransportOptions {
  project: string;
  location: string;
  model: string;
  getAccessToken?: () => string; // default: gcloud ADC token
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number; // injectable clock for token-cache tests
}

// ADC access tokens last ~1h; refresh a little early.
const TOKEN_TTL_MS = 50 * 60 * 1000;

export type GcloudRunner = (args: string[]) => { status: number | null; stdout: string };

// The two ways gcloud mints a cloud-platform token: Application Default
// Credentials first, then the plain user login. First one that works wins, so
// whichever the user has set up is reused — no forced re-login.
export function tokenFrom(run: GcloudRunner): string | null {
  const sources = [
    ["auth", "application-default", "print-access-token"],
    ["auth", "print-access-token"],
  ];
  for (const args of sources) {
    const r = run(args);
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

const spawnGcloud: GcloudRunner = (args) => {
  const r = spawnSync("gcloud", args, { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "" };
};

function gcloudToken(): string {
  const t = tokenFrom(spawnGcloud);
  if (!t) throw new ApiError(0, "no gcloud token. Run `chime login`, or `gcloud auth login`.");
  return t;
}

export function createVertexTransport(opts: VertexTransportOptions): Transport {
  const now = opts.now ?? (() => Date.now());
  const getAccessToken = opts.getAccessToken ?? gcloudToken;
  let cached: { token: string; at: number } | null = null;

  function token(): string {
    if (cached && now() - cached.at < TOKEN_TTL_MS) return cached.token;
    const t = getAccessToken();
    cached = { token: t, at: now() };
    return t;
  }

  return {
    async createMessage(req: CreateMessageRequest): Promise<AnthropicResponse> {
      const model = req.model || opts.model;
      const url =
        `https://${opts.location}-aiplatform.googleapis.com/v1/projects/${opts.project}` +
        `/locations/${opts.location}/publishers/google/models/${model}:generateContent`;
      const data = await postJson<GeminiResponse>({
        url,
        headers: { "content-type": "application/json", authorization: `Bearer ${token()}` },
        body: buildGeminiRequestBody(req),
        fetchImpl: opts.fetchImpl,
        maxRetries: opts.maxRetries,
        sleep: opts.sleep,
      });
      return fromGemini(data, model);
    },
  };
}
