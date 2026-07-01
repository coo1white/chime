import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Capability, HandlerContext, JsonSchema, ToolResultPayload } from "../types.ts";

// The handoff ledger — a shared channel between Chime and Claude Code so the two
// can review each other and hand work back and forth. It is Chime's OWN data
// (under ~/.chime/handoff), so appending here never breaks the strictly-read-only
// stance on the user's project code.
//
// Two verbs over one ledger:
//   propose — write a structured change proposal (Chime never mutates code; it
//             proposes, and Claude Code turns an accepted proposal into a real PR).
//   review  — write a verdict about a proposal (or an external PR ref); when it
//             targets a proposal in the ledger, that proposal's status advances.
// `list` reads the ledger back. Both sides read/append the same JSON file, so the
// data is genuinely shared: Chime writes via this tool; Claude Code writes the
// same schema directly.

export type Party = "chime" | "claude" | "user";
export type EntryKind = "proposal" | "review";
export type Verdict = "approve" | "request-changes" | "comment";
export type Status = "open" | "accepted" | "changes-requested" | "rejected" | "merged" | "done";

export interface Entry {
  id: string;
  kind: EntryKind;
  from: Party;
  to: Party;
  title: string;
  body?: string;
  target?: string[]; // proposals: files / areas the change touches
  ref?: string; // proposals: suggested branch or external ref
  about?: string; // reviews: the proposal id or PR ref being reviewed
  verdict?: Verdict; // reviews
  status: Status;
  createdAt: string;
}

const PARTIES: readonly string[] = ["chime", "claude", "user"];
const VERDICTS: readonly string[] = ["approve", "request-changes", "comment"];

export function ledgerPath(home: string): string {
  return join(home, ".chime", "handoff", "ledger.json");
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

// A review verdict advances the proposal it targets. `comment` leaves it open.
export function statusFromVerdict(verdict: Verdict): Status {
  if (verdict === "approve") return "accepted";
  if (verdict === "request-changes") return "changes-requested";
  return "open";
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
      enum: ["propose", "review", "list"],
      description: "propose = record a change proposal; review = record a verdict about a proposal/PR; list = read the ledger",
    },
    title: { type: "string", description: "propose: a one-line title for the change" },
    body: { type: "string", description: "propose/review: rationale or details" },
    target: { type: "array", items: { type: "string" }, description: "propose: files or areas the change touches" },
    ref: { type: "string", description: "propose: a suggested branch name or external reference" },
    to: { type: "string", enum: ["chime", "claude", "user"], description: "who the entry is for (default: claude)" },
    about: { type: "string", description: "review: the proposal id (e.g. P1) or PR ref (e.g. PR#4) being reviewed" },
    verdict: { type: "string", enum: ["approve", "request-changes", "comment"], description: "review: the verdict" },
    filter: { type: "string", enum: ["all", "open", "proposal", "review"], description: "list: narrow the entries (default: all)" },
  },
  required: ["action"],
  additionalProperties: false,
};

function toParty(v: unknown, fallback: Party): Party {
  return typeof v === "string" && PARTIES.includes(v) ? (v as Party) : fallback;
}

function handler(input: Record<string, unknown>, ctx: HandlerContext): ToolResultPayload {
  const action = String(input.action ?? "");
  const now = ctx.now().toISOString();
  const ledger = readLedger(ctx.home);

  if (action === "propose") {
    const title = String(input.title ?? "").trim();
    if (!title) return { ok: false, action, error: "propose requires a title" };
    const entry: Entry = {
      id: nextId(ledger, "proposal"),
      kind: "proposal",
      from: "chime",
      to: toParty(input.to, "claude"),
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
      from: "chime",
      to: toParty(input.to, "claude"),
      title: `review of ${about}: ${verdict}`,
      about,
      verdict: verdict as Verdict,
      status: "done",
      createdAt: now,
    };
    const body = String(input.body ?? "").trim();
    if (body) entry.body = body;

    // If the review targets a proposal we hold, advance that proposal's status.
    let advanced: string | undefined;
    const next = ledger.map((e) => {
      if (e.id === about && e.kind === "proposal") {
        advanced = statusFromVerdict(verdict as Verdict);
        return { ...e, status: advanced as Status };
      }
      return e;
    });

    try {
      writeLedger(ctx.home, [...next, entry]);
    } catch (e) {
      return { ok: false, action, error: `cannot write ledger: ${e instanceof Error ? e.message : String(e)}` };
    }
    return { ok: true, action, id: entry.id, entry, ...(advanced ? { advanced: { proposal: about, status: advanced } } : {}), path: ledgerPath(ctx.home) };
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

  return { ok: false, action, error: `unknown action: ${action} (expected propose|review|list)` };
}

export const handoff: Capability = {
  name: "handoff",
  description:
    "The shared Chime⇄Claude handoff ledger — how Chime and Claude Code review each other and pass work back and forth. action=propose records a structured change proposal (Chime never edits code; it proposes, and Claude Code turns an accepted proposal into a real PR). action=review records a verdict (approve / request-changes / comment) about a proposal id or PR ref, advancing the proposal's status. action=list reads the ledger. Call propose when you'd change code but must stay read-only; call review to weigh in on a pending proposal; call list to see what's open. Writes only to Chime's own ~/.chime/handoff/ledger.json, never the user's project code.",
  inputSchema,
  handler,
};
