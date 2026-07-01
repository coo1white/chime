import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ConfigError, type Tiers } from "./types.ts";

export type Backend = "anthropic" | "gemini" | "vertex";

export interface Config {
  backend: Backend;
  apiKey: string; // "" for vertex (it uses a gcloud token, not a key)
  model: string; // the default model when the router is off (= tiers.balanced)
  tiers: Tiers;
  router: boolean;
  maxTokens: number;
  maxIterations: number;
  anthropicBaseUrl: string;
  anthropicVersion: string;
  geminiBaseUrl: string;
  vertexProject?: string;
  vertexLocation?: string;
}

// What `chime login` writes to ~/.chime/config.json — a saved backend + Vertex coords.
export interface ChimeFileConfig {
  backend?: Backend;
  project?: string;
  location?: string;
}

export function chimeConfigPath(home: string): string {
  return join(home, ".chime", "config.json");
}

export function readChimeConfig(home: string): ChimeFileConfig {
  const file = chimeConfigPath(home);
  if (!existsSync(file)) return {};
  try {
    const d = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (!d || typeof d !== "object") return {};
    const out: ChimeFileConfig = {};
    if (d.backend === "anthropic" || d.backend === "gemini" || d.backend === "vertex") out.backend = d.backend;
    if (typeof d.project === "string") out.project = d.project;
    if (typeof d.location === "string") out.location = d.location;
    return out;
  } catch {
    return {};
  }
}

// `chime login` writes here (mode 0600). Saved so later runs need no key/env.
export function writeChimeConfig(home: string, cfg: ChimeFileConfig): void {
  const file = chimeConfigPath(home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
}

function posNum(v: string | undefined, fallback: number): number {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Pick the brain backend. Priority: CHIME_BACKEND (env force) > a present API key >
// a saved `chime login` (Vertex) in ~/.chime/config.json. Fail-closed: nothing set
// throws before the REPL starts. Vertex uses a gcloud token, so it needs no key —
// only a project (from CHIME_VERTEX_PROJECT or the saved config).
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const home = env.HOME || homedir();
  const fileCfg = readChimeConfig(home);
  const ant = env.ANTHROPIC_API_KEY;
  const gem = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  const explicit = env.CHIME_BACKEND;

  const vertexCoords = (): { project: string; location: string } => {
    const project = env.CHIME_VERTEX_PROJECT || fileCfg.project;
    const location = env.CHIME_VERTEX_LOCATION || fileCfg.location || "us-central1";
    if (!project) {
      throw new ConfigError("Vertex backend needs a project. Run `chime login`, or set CHIME_VERTEX_PROJECT.");
    }
    return { project, location };
  };

  let backend: Backend;
  let apiKey = "";
  let vertexProject: string | undefined;
  let vertexLocation: string | undefined;

  if (explicit === "vertex") {
    ({ project: vertexProject, location: vertexLocation } = vertexCoords());
    backend = "vertex";
  } else if (explicit === "gemini") {
    if (!gem) throw new ConfigError("CHIME_BACKEND=gemini but GEMINI_API_KEY is not set.");
    backend = "gemini";
    apiKey = gem;
  } else if (explicit === "anthropic") {
    if (!ant) throw new ConfigError("CHIME_BACKEND=anthropic but ANTHROPIC_API_KEY is not set.");
    backend = "anthropic";
    apiKey = ant;
  } else if (ant) {
    backend = "anthropic";
    apiKey = ant;
  } else if (gem) {
    backend = "gemini";
    apiKey = gem;
  } else if (fileCfg.backend === "vertex") {
    ({ project: vertexProject, location: vertexLocation } = vertexCoords());
    backend = "vertex";
  } else {
    throw new ConfigError("No brain configured. Set ANTHROPIC_API_KEY or GEMINI_API_KEY, or run `chime login` for Vertex.");
  }

  const geminiLike = backend === "gemini" || backend === "vertex";
  const tierDefaults = geminiLike
    ? { cheap: "gemini-2.5-flash-lite", balanced: "gemini-2.5-flash", strong: "gemini-2.5-pro" }
    : { cheap: "claude-haiku-4-5", balanced: "claude-sonnet-5", strong: "claude-opus-4-8" };
  const tiers: Tiers = {
    cheap: env.CHIME_TIER_CHEAP || tierDefaults.cheap,
    balanced: env.CHIME_TIER_BALANCED || env.CHIME_MODEL || tierDefaults.balanced,
    strong: env.CHIME_TIER_STRONG || tierDefaults.strong,
  };
  const router = env.CHIME_ROUTER !== "0" && env.CHIME_ROUTER !== "false";

  return {
    backend,
    apiKey,
    model: tiers.balanced,
    tiers,
    router,
    maxTokens: posNum(env.CHIME_MAX_TOKENS, 2048),
    maxIterations: posNum(env.CHIME_MAX_ITERATIONS, 8),
    anthropicBaseUrl: env.CHIME_BASE_URL || "https://api.anthropic.com/v1/messages",
    anthropicVersion: "2023-06-01",
    geminiBaseUrl: env.CHIME_GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta",
    vertexProject,
    vertexLocation,
  };
}
