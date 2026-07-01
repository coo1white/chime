import type { AnthropicTool, Capability } from "./types.ts";
import { TOOLS } from "./tools/index.ts";

// SINGLE SOURCE OF TRUTH: the tools the model sees and the handlers that run are
// two views of this one array, so they can never drift.
export const BUILTIN_CAPABILITIES: Capability[] = [...TOOLS];

// Derive the Anthropic `tools` array from the registry. input_schema is the
// verbatim inputSchema object — no re-shaping.
export function toAnthropicTools(
  reg: Capability[] = BUILTIN_CAPABILITIES,
): AnthropicTool[] {
  return reg.map((c) => ({
    name: c.name,
    description: c.description,
    input_schema: c.inputSchema,
  }));
}

// Explicit lookup by tool name — no dynamic dispatch or eval.
export function findCapability(
  name: string,
  reg: Capability[] = BUILTIN_CAPABILITIES,
): Capability | undefined {
  return reg.find((c) => c.name === name);
}
