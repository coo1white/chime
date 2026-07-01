import type { Tier, Tiers } from "./types.ts";

export interface RouteResult {
  tier: Tier;
  model: string;
  reason: string;
  message: string; // input with any leading override token stripped
}

// Manual override escape hatch: a leading /token forces a tier.
const OVERRIDES: Record<string, Tier> = {
  "/fast": "cheap",
  "/cheap": "cheap",
  "/lite": "cheap",
  "/balanced": "balanced",
  "/mid": "balanced",
  "/strong": "strong",
  "/pro": "strong",
  "/hard": "strong",
};

// Hard-work signals → strong. Keep these tunable in one place.
const STRONG_EN =
  /\b(debug|refactor|architect|optimi[sz]e|anal(?:yse|yze|ysis)|design|plan|algorithm|prove|proof|implement|complex|review|trade-?offs?|in depth|step by step|carefully|thorough)\b/i;
const STRONG_CJK = /(写代码|代码|调试|重构|推理|分析|设计|方案|算法|复杂|仔细|详细|深入|证明|实现|优化)/;

// Trivial signals → cheap (only when the message is also short). Matched by an
// exact set (works for CJK, where \b word boundaries don't fire) plus an ASCII
// prefix rule (so "thanks!" / "hello there" still count).
const TRIVIAL_SET = new Set([
  "hi", "hello", "hey", "yo", "sup", "thanks", "thank you", "ok", "okay", "k",
  "yes", "no", "yep", "nope", "ping", "cool", "nice", "great",
  "你好", "您好", "谢谢", "多谢", "好的", "好", "嗯", "在吗", "在不在",
]);
const TRIVIAL_PREFIX =
  /^(hi|hello|hey|yo|sup|thanks?|thank you|ok|okay|yes|no|yep|nope|ping|cool|nice|great)\b/i;

function isTrivial(s: string): boolean {
  const low = s.toLowerCase().replace(/[!.?,~ ]+$/, "");
  return TRIVIAL_SET.has(low) || TRIVIAL_PREFIX.test(s);
}

const STRONG_CHARS = 600;
const STRONG_WORDS = 80;
const CHEAP_CHARS = 40;
const CHEAP_WORDS = 6;

function mk(tier: Tier, tiers: Tiers, reason: string, message: string): RouteResult {
  return { tier, model: tiers[tier], reason, message };
}

// Deterministic, zero-extra-call routing. Default is balanced; escalate to strong on
// clear difficulty signals, drop to cheap on clear trivial signals.
export function route(input: string, tiers: Tiers): RouteResult {
  const trimmed = input.trim();

  // 1) manual override
  const sp = trimmed.search(/\s/);
  const firstTok = (sp === -1 ? trimmed : trimmed.slice(0, sp)).toLowerCase();
  const forced = OVERRIDES[firstTok];
  if (forced) {
    const message = sp === -1 ? "" : trimmed.slice(sp + 1).trim();
    return mk(forced, tiers, `override ${firstTok}`, message);
  }

  // 2) heuristic
  const chars = trimmed.length;
  const words = trimmed.split(/\s+/).filter(Boolean).length;

  if (chars >= STRONG_CHARS || words >= STRONG_WORDS) return mk("strong", tiers, "long input", trimmed);
  if (STRONG_EN.test(trimmed) || STRONG_CJK.test(trimmed)) return mk("strong", tiers, "complex keyword", trimmed);
  if (chars <= CHEAP_CHARS && words <= CHEAP_WORDS && isTrivial(trimmed)) {
    return mk("cheap", tiers, "short/trivial", trimmed);
  }
  return mk("balanced", tiers, "default", trimmed);
}
