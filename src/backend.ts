import { spawnSync } from "node:child_process";
import * as os from "node:os";
import type { CommandResult, HandlerContext, Transport } from "./types.ts";
import type { Config } from "./config.ts";
import { createHttpTransport } from "./anthropic.ts";
import { createGeminiTransport } from "./gemini.ts";
import { createVertexTransport } from "./vertex.ts";

// Construct the right brain transport for the selected backend.
export function buildTransport(config: Config): Transport {
  if (config.backend === "vertex") {
    return createVertexTransport({
      project: config.vertexProject!,
      location: config.vertexLocation ?? "us-central1",
      model: config.model,
    });
  }
  if (config.backend === "gemini") {
    return createGeminiTransport({ apiKey: config.apiKey, model: config.model, baseUrl: config.geminiBaseUrl });
  }
  return createHttpTransport({
    apiKey: config.apiKey,
    baseUrl: config.anthropicBaseUrl,
    anthropicVersion: config.anthropicVersion,
  });
}

// The real handler context: spawnSync (no shell), merged env, a timeout, real clock/home.
export function realHandlerContext(): HandlerContext {
  const runCommand = (
    cmd: string,
    args: string[],
    opts?: { env?: Record<string, string | undefined>; timeoutMs?: number; cwd?: string },
  ): CommandResult => {
    const r = spawnSync(cmd, args, {
      encoding: "utf8",
      env: { ...process.env, ...(opts?.env ?? {}) },
      timeout: opts?.timeoutMs ?? 180_000,
      cwd: opts?.cwd,
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error?.message };
  };
  return { runCommand, env: process.env, now: () => new Date(), home: os.homedir() };
}
