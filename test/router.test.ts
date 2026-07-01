import { test } from "node:test";
import assert from "node:assert/strict";
import { route } from "../src/router.ts";
import type { Tiers } from "../src/types.ts";

const tiers: Tiers = { cheap: "C", balanced: "B", strong: "S" };

test("greetings / acks → cheap", () => {
  for (const s of ["hi", "hello", "thanks!", "ok", "你好", "嗯"]) {
    const r = route(s, tiers);
    assert.equal(r.tier, "cheap", `expected cheap for ${s}`);
    assert.equal(r.model, "C");
  }
});

test("code / reasoning keywords → strong", () => {
  for (const s of ["refactor this function", "debug the failing test", "请帮我分析这段代码", "design a plan for X"]) {
    const r = route(s, tiers);
    assert.equal(r.tier, "strong", `expected strong for ${s}`);
    assert.equal(r.model, "S");
  }
});

test("long input → strong", () => {
  const long = "please " + "word ".repeat(100);
  assert.equal(route(long, tiers).tier, "strong");
});

test("ordinary questions → balanced", () => {
  for (const s of ["what's the weather like today", "how's my disk space?", "remind me to call mom"]) {
    const r = route(s, tiers);
    assert.equal(r.tier, "balanced", `expected balanced for ${s}`);
    assert.equal(r.model, "B");
  }
});

test("manual override forces tier and strips the token", () => {
  const a = route("/strong hi", tiers);
  assert.equal(a.tier, "strong");
  assert.equal(a.message, "hi");

  const b = route("/fast explain recursion", tiers);
  assert.equal(b.tier, "cheap");
  assert.equal(b.message, "explain recursion");

  const c = route("/pro", tiers);
  assert.equal(c.tier, "strong");
  assert.equal(c.message, "");
});

test("non-override messages pass through unchanged; reason is set", () => {
  const r = route("hello there", tiers);
  assert.equal(r.message, "hello there");
  assert.ok(r.reason.length > 0);
});
