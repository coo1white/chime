import * as readline from "node:readline";
import type { Capability, HandlerContext, Message, Tiers, Transport } from "./types.ts";
import { runTurn, type BrainConfig } from "./brain.ts";
import { route } from "./router.ts";

export const SYSTEM_PROMPT = `You are Chime, the user's personal terminal secretary — for their Mac and for every
project under ~/Developer.

Two ideas guide you:
- FreeBSD discipline: least surprise, fail closed, say what you did and what it means.
- Homebrew spirit: few clear steps, strong checks, plain next steps, boring recovery.

Your tools:
- colima_disk: check or reclaim the Docker/Colima VM disk (local machine upkeep).
- projects: list the user's repos, or show one project's card (purpose, mantra, path, commands).
- project_status: live git branch, dirty state, HEAD, and version — of one repo or all.
- project_check: run one repo's own fast, non-mutating gate (lint / typecheck) and report PASS or FAIL.
- project_health: curl a deployed site's health URL and report up or down.
- memory: keep and recall notes about a project across sessions (~/.chime/memory) — the four
  sections are Verified Facts, Failed Attempts, Last Session, Next Run.
- self_iteration: read-only self-review mode for one project; inspect git scope,
  name what to keep, what to change, and the next small step.

How to act:
- Look before you act: prefer status, check, health, or a preview first.
- Use memory to recall a project before you start, and to record durable facts, what you did
  (Last Session), and what is next (Next Run).
- When the user asks to self-iterate or reflect, call self_iteration for the project.
- You are STRICTLY READ-ONLY on projects. You cannot release, deploy, restart, or edit
  code — you have no tool for it. If the user wants any of those, give the exact next-step
  command and let them run it themselves.
- Each project has a four-beat mantra (like ask simple -> run simple -> verify simple ->
  resume simple). Use the projects tool to recall it.
- Reply in Basic English: short simple words, short and concrete. Say the one thing that matters.`;

export interface ReplDeps {
  transport: Transport;
  registry: Capability[];
  config: BrainConfig; // config.model is the default model when the router is off
  ctx: HandlerContext;
  tiers: Tiers;
  router: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

// Read a line → (route to a model tier) → run one turn → print → re-prompt. History
// is the only conversation state; a failed turn drops its user message. Exit on
// exit/quit/EOF.
export async function repl(deps: ReplDeps): Promise<void> {
  const input = deps.input ?? process.stdin;
  const output = deps.output ?? process.stdout;
  const rl = readline.createInterface({ input, output });
  let history: Message[] = [];

  output.write("Chime — type a message, or 'exit' to quit.\n");
  output.write("chime> ");
  for await (const line of rl) {
    const text = line.trim();
    if (text === "") {
      output.write("chime> ");
      continue;
    }
    if (text === "exit" || text === "quit") {
      break;
    }

    let model = deps.config.model;
    let message = text;
    if (deps.router) {
      const r = route(text, deps.tiers);
      model = r.model;
      message = r.message || text;
      process.stderr.write(`[chime] tier=${r.tier} (${model})\n`);
    }
    if (message === "") {
      // a bare override token like "/pro" with no actual message
      output.write("chime> ");
      continue;
    }

    history.push({ role: "user", content: message });
    try {
      const res = await runTurn(history, deps.transport, deps.registry, { ...deps.config, model }, deps.ctx);
      history = res.history;
      output.write(`${res.reply}\n`);
    } catch (err) {
      history.pop(); // drop the failed user turn — don't poison the context
      const m = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[chime:error] ${m}\n`);
    }
    output.write("chime> ");
  }
  rl.close();
  output.write("\nbye\n");
}
