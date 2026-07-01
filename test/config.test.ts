import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, chimeConfigPath } from "../src/config.ts";
import { ConfigError } from "../src/types.ts";

// Every test runs against an isolated, empty HOME so a real ~/.chime never leaks in.
function emptyHome(): string {
  return mkdtempSync(join(tmpdir(), "chime-cfg-"));
}
// A HOME with a saved ~/.chime/config.json.
function homeWithConfig(cfgObj: unknown): string {
  const home = emptyHome();
  mkdirSync(join(home, ".chime"), { recursive: true });
  writeFileSync(chimeConfigPath(home), JSON.stringify(cfgObj));
  return home;
}
function cfg(env: Record<string, string | undefined>) {
  return loadConfig({ HOME: emptyHome(), ...env });
}

test("no key at all fails closed", () => {
  assert.throws(() => loadConfig({ HOME: emptyHome() }), ConfigError);
});

test("ANTHROPIC_API_KEY → anthropic backend + claude tiers (default model = balanced)", () => {
  const c = cfg({ ANTHROPIC_API_KEY: "sk-ant" });
  assert.equal(c.backend, "anthropic");
  assert.equal(c.apiKey, "sk-ant");
  assert.deepEqual(c.tiers, { cheap: "claude-haiku-4-5", balanced: "claude-sonnet-5", strong: "claude-opus-4-8" });
  assert.equal(c.model, "claude-sonnet-5");
  assert.equal(c.router, true);
  assert.equal(c.anthropicVersion, "2023-06-01");
});

test("GEMINI_API_KEY → gemini backend + gemini tiers", () => {
  const c = cfg({ GEMINI_API_KEY: "g-key" });
  assert.equal(c.backend, "gemini");
  assert.equal(c.apiKey, "g-key");
  assert.deepEqual(c.tiers, { cheap: "gemini-2.5-flash-lite", balanced: "gemini-2.5-flash", strong: "gemini-2.5-pro" });
  assert.equal(c.model, "gemini-2.5-flash");
  assert.match(c.geminiBaseUrl, /generativelanguage\.googleapis\.com/);
});

test("CHIME_TIER_* overrides + CHIME_MODEL sets balanced; CHIME_ROUTER=0 disables", () => {
  const c = cfg({
    GEMINI_API_KEY: "g",
    CHIME_TIER_STRONG: "gemini-3.1-pro-preview",
    CHIME_TIER_CHEAP: "gemini-3.1-flash-lite",
    CHIME_MODEL: "gemini-3.5-flash",
    CHIME_ROUTER: "0",
  });
  assert.equal(c.tiers.strong, "gemini-3.1-pro-preview");
  assert.equal(c.tiers.cheap, "gemini-3.1-flash-lite");
  assert.equal(c.tiers.balanced, "gemini-3.5-flash");
  assert.equal(c.model, "gemini-3.5-flash");
  assert.equal(c.router, false);
});

test("GOOGLE_API_KEY is accepted as the gemini key too", () => {
  const c = cfg({ GOOGLE_API_KEY: "g2" });
  assert.equal(c.backend, "gemini");
  assert.equal(c.apiKey, "g2");
});

test("both keys → anthropic wins; CHIME_BACKEND=gemini forces gemini", () => {
  const both = cfg({ ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g" });
  assert.equal(both.backend, "anthropic");
  const forced = cfg({ ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g", CHIME_BACKEND: "gemini" });
  assert.equal(forced.backend, "gemini");
  assert.equal(forced.apiKey, "g");
});

test("CHIME_BACKEND=gemini without a gemini key fails closed", () => {
  assert.throws(() => cfg({ ANTHROPIC_API_KEY: "a", CHIME_BACKEND: "gemini" }), ConfigError);
});

test("env overrides; bad numbers fall back", () => {
  const c = cfg({ GEMINI_API_KEY: "g", CHIME_MODEL: "gemini-2.5-pro", CHIME_MAX_TOKENS: "500", CHIME_MAX_ITERATIONS: "3" });
  assert.equal(c.model, "gemini-2.5-pro");
  assert.equal(c.maxTokens, 500);
  assert.equal(c.maxIterations, 3);
  const bad = cfg({ GEMINI_API_KEY: "g", CHIME_MAX_TOKENS: "nope", CHIME_MAX_ITERATIONS: "-2" });
  assert.equal(bad.maxTokens, 2048);
  assert.equal(bad.maxIterations, 8);
});

// --- Vertex (gcloud login) ---

test("a saved vertex login (config.json) with no keys selects vertex + gemini tiers", () => {
  const home = homeWithConfig({ backend: "vertex", project: "demo-project", location: "us-central1" });
  const c = loadConfig({ HOME: home });
  assert.equal(c.backend, "vertex");
  assert.equal(c.apiKey, "");
  assert.equal(c.vertexProject, "demo-project");
  assert.equal(c.vertexLocation, "us-central1");
  assert.equal(c.tiers.balanced, "gemini-2.5-flash");
});

test("CHIME_BACKEND=vertex + CHIME_VERTEX_PROJECT works, location defaults to us-central1", () => {
  const c = cfg({ CHIME_BACKEND: "vertex", CHIME_VERTEX_PROJECT: "p" });
  assert.equal(c.backend, "vertex");
  assert.equal(c.vertexProject, "p");
  assert.equal(c.vertexLocation, "us-central1");
});

test("vertex without a project fails closed", () => {
  assert.throws(() => cfg({ CHIME_BACKEND: "vertex" }), ConfigError);
});

test("a saved vertex login PINS over a stray env key (privacy lock)", () => {
  const home = homeWithConfig({ backend: "vertex", project: "p" });
  // a leftover GEMINI_API_KEY must NOT silently switch a private vertex user to the free tier
  const pinned = loadConfig({ HOME: home, GEMINI_API_KEY: "stray", ANTHROPIC_API_KEY: "a" });
  assert.equal(pinned.backend, "vertex");
  assert.equal(pinned.vertexProject, "p");
  // CHIME_BACKEND is the deliberate escape hatch
  const overridden = loadConfig({ HOME: home, ANTHROPIC_API_KEY: "a", CHIME_BACKEND: "anthropic" });
  assert.equal(overridden.backend, "anthropic");
});
