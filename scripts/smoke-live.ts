// Opt-in live smoke (NOT part of `npm test`, which stays offline). Skips cleanly
// when neither ANTHROPIC_API_KEY nor GEMINI_API_KEY is set; otherwise runs one real
// turn against the selected backend and asserts the model reached for colima_disk.
import { loadConfig } from "../src/config.ts";
import { buildTransport, realHandlerContext } from "../src/backend.ts";
import { BUILTIN_CAPABILITIES } from "../src/registry.ts";
import { SYSTEM_PROMPT } from "../src/repl.ts";
import { runTurn } from "../src/brain.ts";
import type { ContentBlock, Message, ToolUseBlock } from "../src/types.ts";

if (!process.env.ANTHROPIC_API_KEY && !process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
  process.stdout.write("smoke-live: no ANTHROPIC_API_KEY / GEMINI_API_KEY — SKIP\n");
  process.exit(0);
}

const config = loadConfig();
process.stdout.write(`smoke-live: backend=${config.backend} model=${config.model}\n`);

const history: Message[] = [
  { role: "user", content: "How's my disk space? Check with your tools, then tell me in one sentence." },
];
const res = await runTurn(
  history,
  buildTransport(config),
  BUILTIN_CAPABILITIES,
  { model: config.model, maxTokens: config.maxTokens, system: SYSTEM_PROMPT, maxIterations: config.maxIterations },
  realHandlerContext(),
);

const calledColima = res.history.some(
  (m: Message) =>
    Array.isArray(m.content) &&
    (m.content as ContentBlock[]).some(
      (b) => b.type === "tool_use" && (b as ToolUseBlock).name === "colima_disk",
    ),
);

process.stdout.write(`\n--- reply ---\n${res.reply}\n`);
process.stdout.write(`\nsmoke-live: colima_disk called = ${calledColima}; stopReason = ${res.stopReason}\n`);
if (!calledColima) {
  process.stderr.write("smoke-live: FAIL — the model did not call colima_disk\n");
  process.exit(1);
}
process.stdout.write("smoke-live: PASS\n");
