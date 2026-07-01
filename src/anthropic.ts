import type { AnthropicResponse, CreateMessageRequest, Transport } from "./types.ts";
import { postJson } from "./http.ts";

export interface HttpTransportOptions {
  apiKey: string;
  baseUrl: string;
  anthropicVersion: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

// Raw Anthropic Messages API client over the global fetch — no SDK.
export function createHttpTransport(opts: HttpTransportOptions): Transport {
  return {
    async createMessage(req: CreateMessageRequest): Promise<AnthropicResponse> {
      return postJson<AnthropicResponse>({
        url: opts.baseUrl,
        headers: {
          "content-type": "application/json",
          "x-api-key": opts.apiKey,
          "anthropic-version": opts.anthropicVersion,
        },
        body: req,
        fetchImpl: opts.fetchImpl,
        maxRetries: opts.maxRetries,
        sleep: opts.sleep,
      });
    },
  };
}
