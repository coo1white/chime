import type {
  Capability,
  ContentBlock,
  CreateMessageRequest,
  HandlerContext,
  Message,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  Transport,
} from "./types.ts";
import { toAnthropicTools } from "./registry.ts";
import { executeToolUse } from "./dispatch.ts";

export interface BrainConfig {
  model: string;
  maxTokens: number;
  system: string;
  maxIterations: number;
}

export interface TurnResult {
  history: Message[];
  reply: string;
  stopReason: string;
}

function textOf(content: ContentBlock[]): string {
  let out = "";
  for (const b of content) {
    if (b.type === "text" && typeof (b as TextBlock).text === "string") {
      out += (b as TextBlock).text;
    }
  }
  return out;
}

// Run one user turn to completion: call Claude, and while it asks for tools, run
// them and feed the results back, until it stops with a terminal stop_reason.
// Returns the grown history (so the REPL can keep the conversation) and the reply
// text to print. A hard maxIterations bound prevents an unbounded tool loop.
export async function runTurn(
  history: Message[],
  transport: Transport,
  registry: Capability[],
  config: BrainConfig,
  ctx: HandlerContext,
): Promise<TurnResult> {
  const tools = toAnthropicTools(registry);
  let messages = history.slice();
  const replyParts: string[] = [];

  for (let i = 0; i < config.maxIterations; i++) {
    const req: CreateMessageRequest = {
      model: config.model,
      max_tokens: config.maxTokens,
      system: config.system,
      tools,
      messages,
    };
    const res = await transport.createMessage(req);

    // Append the assistant content verbatim — the follow-up tool_result blocks must
    // reference a real assistant turn that contains the matching tool_use blocks.
    messages = [...messages, { role: "assistant", content: res.content }];
    const text = textOf(res.content);
    if (text) replyParts.push(text);

    if (res.stop_reason === "tool_use") {
      const toolUses = res.content.filter(
        (b): b is ToolUseBlock => b.type === "tool_use",
      );
      const results: ToolResultBlock[] = await Promise.all(
        toolUses.map((b) => executeToolUse(b, registry, ctx)),
      );
      // All tool_result blocks for a turn go back in ONE user message.
      messages = [...messages, { role: "user", content: results }];
      continue;
    }

    // Terminal: end_turn / max_tokens / stop_sequence / refusal / pause_turn / other.
    if (res.stop_reason === "refusal" && !text) {
      replyParts.push("(the model declined to respond)");
    } else if (res.stop_reason === "max_tokens" && !text) {
      replyParts.push("(response hit the token limit before any text)");
    }
    return {
      history: messages,
      reply: replyParts.join("\n").trim(),
      stopReason: String(res.stop_reason),
    };
  }

  // Tool budget exhausted — stop gracefully rather than loop forever.
  replyParts.push("(stopped: reached the tool-call limit for this turn)");
  return {
    history: messages,
    reply: replyParts.join("\n").trim(),
    stopReason: "max_iterations",
  };
}
