// Shared contracts for Chime. Field names that mirror the Anthropic Messages API
// live here in one place, so a wire-shape correction touches this file only.

// --- Anthropic message / content-block shapes (only what Chime uses) ---

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

// Content blocks Chime sends or receives: assistant text/tool_use, the tool_result
// blocks we send back, plus a defensive pass-through for anything else.
export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | { type: string; [k: string]: unknown };

export type Role = "user" | "assistant";

export interface Message {
  role: Role;
  // The API accepts a plain string for simple user turns, or an array of blocks.
  content: string | ContentBlock[];
}

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "refusal"
  | "pause_turn"
  | (string & {});

export interface AnthropicResponse {
  role: "assistant";
  content: ContentBlock[];
  stop_reason: StopReason;
  stop_sequence?: string | null;
  model?: string;
  usage?: Record<string, unknown>;
}

// --- Tool definitions (the Anthropic `tools` array, derived from the registry) ---

export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

export interface CreateMessageRequest {
  model: string;
  max_tokens: number;
  system?: string;
  tools?: AnthropicTool[];
  messages: Message[];
}

// The injectable seam for the brain loop: real HTTP impl, or a fake in tests.
export interface Transport {
  createMessage(req: CreateMessageRequest): Promise<AnthropicResponse>;
}

// --- Capability / handler contracts (the registry rows) ---

// What a handler returns. `ok: false` makes dispatch mark the tool_result is_error.
export interface ToolResultPayload {
  ok: boolean;
  [k: string]: unknown;
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export type RunCommand = (
  cmd: string,
  args: string[],
  opts?: { env?: Record<string, string | undefined>; timeoutMs?: number; cwd?: string },
) => CommandResult;

// Injectable context for handlers — the seam that lets tool tests avoid the real
// script and wall clock.
export interface HandlerContext {
  runCommand: RunCommand;
  env: Record<string, string | undefined>;
  now: () => Date;
  home: string;
}

export type Handler = (
  input: Record<string, unknown>,
  ctx: HandlerContext,
) => ToolResultPayload | Promise<ToolResultPayload>;

export interface Capability {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: Handler;
}

// --- Model routing ---

export type Tier = "cheap" | "balanced" | "strong";

export interface Tiers {
  cheap: string;
  balanced: string;
  strong: string;
}

// --- Errors ---

export class ChimeError extends Error {}

export class ConfigError extends ChimeError {}

export class ApiError extends ChimeError {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}
