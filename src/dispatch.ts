import type {
  Capability,
  HandlerContext,
  ToolResultBlock,
  ToolUseBlock,
} from "./types.ts";
import { findCapability } from "./registry.ts";

// Route one tool_use block through the registry to a structured tool_result.
// Fail-closed: an unknown tool, a handler that throws, and a handler that returns
// { ok: false } all become a tool_result with is_error true — never a crash, so the
// brain loop continues and the model can recover or explain.
export async function executeToolUse(
  block: ToolUseBlock,
  reg: Capability[],
  ctx: HandlerContext,
): Promise<ToolResultBlock> {
  const tool_use_id = block.id;
  const cap = findCapability(block.name, reg);
  if (!cap) {
    return {
      type: "tool_result",
      tool_use_id,
      is_error: true,
      content: JSON.stringify({ ok: false, error: `unknown tool: ${block.name}` }),
    };
  }
  try {
    const payload = await cap.handler(block.input ?? {}, ctx);
    return {
      type: "tool_result",
      tool_use_id,
      is_error: payload.ok === false,
      content: JSON.stringify(payload),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      type: "tool_result",
      tool_use_id,
      is_error: true,
      content: JSON.stringify({ ok: false, error: message }),
    };
  }
}
