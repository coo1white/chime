import { loadConfig } from "./config.ts";
import { buildTransport, realHandlerContext } from "./backend.ts";
import { BUILTIN_CAPABILITIES } from "./registry.ts";
import { repl, SYSTEM_PROMPT } from "./repl.ts";
import { runLogin } from "./login.ts";
import { ConfigError } from "./types.ts";

export async function main(): Promise<number> {
  const cmd = process.argv[2];
  if (cmd === "login") {
    return runLogin();
  }
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(
      "chime — a personal terminal secretary.\n\n" +
        "  chime           start the assistant (REPL)\n" +
        "  chime login     sign in with Google (gcloud) for Vertex — no key needed after\n" +
        "  chime help      show this help\n",
    );
    return 0;
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`chime: ${err.message}\n`);
      return 1;
    }
    throw err;
  }

  const where = config.backend === "vertex" ? ` project=${config.vertexProject}` : "";
  process.stderr.write(
    `[chime] backend=${config.backend}${where} router=${config.router ? "on" : "off"} model=${config.model}\n`,
  );
  // If a key is set but the saved login pinned a different backend, say so — don't
  // let a stray env key look like it's in charge.
  const strayKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (config.backend === "vertex" && strayKey && process.env.CHIME_BACKEND !== "vertex") {
    process.stderr.write(
      "[chime] note: backend pinned to vertex by your saved login; ignoring an env API key. Set CHIME_BACKEND to override.\n",
    );
  }

  await repl({
    transport: buildTransport(config),
    registry: BUILTIN_CAPABILITIES,
    config: {
      model: config.model,
      maxTokens: config.maxTokens,
      system: SYSTEM_PROMPT,
      maxIterations: config.maxIterations,
    },
    ctx: realHandlerContext(),
    tiers: config.tiers,
    router: config.router,
  });
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`chime: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
