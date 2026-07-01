import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Capability, HandlerContext, JsonSchema, ToolResultPayload } from "../types.ts";

// The handoff ledger — a shared, vendor-neutral channel for MULTI-AGENT,
// cross-platform collaboration. Any agent (claude, codex, deepseek, gemini,
// chime, …) can propose changes and review each other's proposals; the ledger
// does not care who writes, so arbitrary permutations of agents can work
// together over it. It is Chime's OWN data (under ~/.chime/handoff), so appending
// here never breaks the strictly-read-only stance on the user's project code.
//
// Two verbs over one ledger:
//   propose — write a structured change proposal (an agent proposes instead of
//             mutating code; a coding agent turns an accepted proposal into a PR).
//   review  — write a verdict about a proposal (or an external PR ref). A proposal
//             can gather reviews from MANY agents; its status reflects the
//             consensus of all of them, not just the last vote.
// `list` reads the ledger; `status` shows one proposal with its review panel and
// the computed consensus. Every entry carries `from`/`to`, so work flows in any
// direction between any pair (or a broadcast to `all`).

// Agent identities are open (any slug), so new platforms need no code change.
export type Agent = string;
export type EntryKind = "proposal" | "review";
export type Verdict = "approve" | "request-changes" | "comment";
export type Status = "open" | "accepted" | "changes-requested" | "rejected" | "merged" | "done";

export interface Entry {
  id: string;
  kind: EntryKind;
  from: Agent;
  to: Agent; // a specific agent, or "all" for a broadcast
  title: string;
  body?: string;
  target?: string[]; // proposals: files / areas the change touches
  ref?: string; // proposals: suggested branch or external ref
  about?: string; // reviews: the proposal id or PR ref being reviewed
  verdict?: Verdict; // reviews
  status: Status;
  createdAt: string;
}

// Known platforms — a hint for callers and docs, NOT an allow-list. Any non-empty
// slug is accepted, so Claude/Codex/DeepSeek/Gemini/… compose without code edits.
export const KNOWN_AGENTS = ["claude", "codex", "deepseek", "gemini", "chime", "user"] as const;
const VERDICTS: readonly string[] = ["approve", "request-changes", "comment"];

export function ledgerPath(home: string): string {
  return join(home, ".chime", "handoff", "ledger.json");
}

// Coerce any input into a safe agent slug ([a-z0-9-]); empty falls back.
export function normalizeAgent(v: unknown, fallback = ""): string {
  if (typeof v !== "string") return fallback;
  const s = v
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || fallback;
}

// Fail-soft parse: a hand-edited or absent ledger yields [], never a throw.
export function parseLedger(text: string): Entry[] {
  try {
    const data = JSON.parse(text);
    return Array.isArray(data) ? (data.filter((e) => e && typeof e === "object" && typeof (e as Entry).id === "string") as Entry[]) : [];
  } catch {
    return [];
  }
}

function readLedger(home: string): Entry[] {
  const file = ledgerPath(home);
  return existsSync(file) ? parseLedger(readFileSync(file, "utf8")) : [];
}

// Sequential per-kind id: P1, P2… for proposals; R1, R2… for reviews.
export function nextId(ledger: Entry[], kind: EntryKind): string {
  const prefix = kind === "proposal" ? "P" : "R";
  const n = ledger.filter((e) => e.kind === kind).length + 1;
  return `${prefix}${n}`;
}

// Single-verdict → status (kept for callers that want the one-vote mapping).
export function statusFromVerdict(verdict: Verdict): Status {
  if (verdict === "approve") return "accepted";
  if (verdict === "request-changes") return "changes-requested";
  return "open";
}

export interface Consensus {
  approve: number;
  requestChanges: number;
  comment: number;
  verdict: Status; // accepted / changes-requested / open, by net of the panel
  reviewers: Agent[];
}

// The panel view: tally verdicts across every review of a proposal. Net of
// approvals over change-requests decides — so 3 approve + 1 request-changes is
// accepted, and a lone block holds it. This is what lets many agents co-review.
export function consensus(reviews: Entry[]): Consensus {
  let approve = 0;
  let requestChanges = 0;
  let comment = 0;
  const reviewers: Agent[] = [];
  for (const r of reviews) {
    if (r.verdict === "approve") approve++;
    else if (r.verdict === "request-changes") requestChanges++;
    else if (r.verdict === "comment") comment++;
    reviewers.push(r.from);
  }
  const net = approve - requestChanges;
  const verdict: Status = net > 0 ? "accepted" : net < 0 ? "changes-requested" : "open";
  return { approve, requestChanges, comment, verdict, reviewers };
}

function writeLedger(home: string, ledger: Entry[]): void {
  const file = ledgerPath(home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

const inputSchema: JsonSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["propose", "review", "list", "status"],
      description: "propose = record a change proposal; review = record a verdict; list = read the ledger; status = one proposal + its review panel & consensus",
    },
    from: { type: "string", description: "the authoring agent (e.g. claude, codex, deepseek, gemini, chime). Default: chime" },
    to: { type: "string", description: "the recipient agent, or 'all' to broadcast (default: claude)" },
    title: { type: "string", description: "propose: a one-line title for the change" },
    body: { type: "string", description: "propose/review: rationale or details" },
    target: { type: "array", items: { type: "string" }, description: "propose: files or areas the change touches" },
    ref: { type: "string", description: "propose: a suggested branch name or external reference" },
    about: { type: "string", description: "review/status: the proposal id (e.g. P1) or PR ref (e.g. PR#4)" },
    verdict: { type: "string", enum: ["approve", "request-changes", "comment"], description: "review: the verdict" },
    filter: { type: "string", enum: ["all", "open", "proposal", "review"], description: "list: narrow the entries (default: all)" },
  },
  required: ["action"],
  additionalProperties: false,
};

function handler(input: Record<string, unknown>, ctx: HandlerContext): ToolResultPayload {
  const action = String(input.action ?? "");
  const now = ctx.now().toISOString();
  const ledger = readLedger(ctx.home);
  const from = normalizeAgent(input.from, "chime");
  const to = normalizeAgent(input.to, "claude");

  if (action === "propose") {
    const title = String(input.title ?? "").trim();
    if (!title) return { ok: false, action, error: "propose requires a title" };
    const entry: Entry = {
      id: nextId(ledger, "proposal"),
      kind: "proposal",
      from,
      to,
      title,
      status: "open",
      createdAt: now,
    };
    const body = String(input.body ?? "").trim();
    if (body) entry.body = body;
    if (Array.isArray(input.target)) {
      const t = input.target.filter((x): x is string => typeof x === "string");
      if (t.length) entry.target = t;
    }
    const ref = String(input.ref ?? "").trim();
    if (ref) entry.ref = ref;

    try {
      writeLedger(ctx.home, [...ledger, entry]);
    } catch (e) {
      return { ok: false, action, error: `cannot write ledger: ${e instanceof Error ? e.message : String(e)}` };
    }
    return { ok: true, action, id: entry.id, entry, path: ledgerPath(ctx.home) };
  }

  if (action === "review") {
    const about = String(input.about ?? "").trim();
    const verdict = String(input.verdict ?? "");
    if (!about) return { ok: false, action, error: "review requires `about` (a proposal id or PR ref)" };
    if (!VERDICTS.includes(verdict)) {
      return { ok: false, action, error: `unknown verdict: ${verdict} (expected one of ${VERDICTS.join(", ")})` };
    }
    const entry: Entry = {
      id: nextId(ledger, "review"),
      kind: "review",
      from,
      to,
      title: `${from} review of ${about}: ${verdict}`,
      about,
      verdict: verdict as Verdict,
      status: "done",
      createdAt: now,
    };
    const body = String(input.body ?? "").trim();
    if (body) entry.body = body;

    // A proposal's status is the CONSENSUS of all its reviews (incl. this one),
    // so many agents can co-review and a single block still holds it.
    const panel = [...ledger.filter((e) => e.kind === "review" && e.about === about), entry];
    const verdictOfPanel = consensus(panel).verdict;
    let advanced: { proposal: string; status: Status; reviewers: Agent[] } | undefined;
    const next = ledger.map((e) => {
      if (e.id === about && e.kind === "proposal") {
        advanced = { proposal: about, status: verdictOfPanel, reviewers: consensus(panel).reviewers };
        return { ...e, status: verdictOfPanel };
      }
      return e;
    });

    try {
      writeLedger(ctx.home, [...next, entry]);
    } catch (e) {
      return { ok: false, action, error: `cannot write ledger: ${e instanceof Error ? e.message : String(e)}` };
    }
    return { ok: true, action, id: entry.id, entry, ...(advanced ? { advanced } : {}), path: ledgerPath(ctx.home) };
  }

  if (action === "status") {
    const about = String(input.about ?? "").trim();
    if (!about) return { ok: false, action, error: "status requires `about` (a proposal id)" };
    const proposal = ledger.find((e) => e.id === about && e.kind === "proposal") ?? null;
    const reviews = ledger.filter((e) => e.kind === "review" && e.about === about);
    return { ok: true, action, about, proposal, reviews, consensus: consensus(reviews) };
  }

  if (action === "list") {
    const filter = String(input.filter ?? "all");
    const entries = ledger.filter((e) => {
      if (filter === "open") return e.status === "open";
      if (filter === "proposal" || filter === "review") return e.kind === filter;
      return true;
    });
    return { ok: true, action, count: entries.length, entries };
  }

  return { ok: false, action, error: `unknown action: ${action} (expected propose|review|list|status)` };
}

export const handoff: Capability = {
  name: "handoff",
  description:
    "The shared multi-agent handoff ledger — how any agents (claude, codex, deepseek, gemini, chime, …) collaborate cross-platform: propose changes and review each other. action=propose records a structured change proposal (an agent proposes instead of editing code; a coding agent turns an accepted proposal into a real PR). action=review records a verdict (approve / request-changes / comment) about a proposal id or PR ref; a proposal's status reflects the CONSENSUS of all its reviews, so many agents can co-review. action=status shows one proposal with its review panel and consensus. action=list reads the ledger. Every entry has from/to (any agent slug, or to='all' to broadcast). Writes only to Chime's own ~/.chime/handoff/ledger.json, never the user's project code.",
  inputSchema,
  handler,
};
