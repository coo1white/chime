import { readFileSync } from "node:fs";
import type { Capability, HandlerContext, JsonSchema, ToolResultPayload } from "../types.ts";
import {
  buildLedgerProposal,
  buildLedgerReview,
  verifyLedgerEntry,
  listLedgerEntries,
  unionLedgerEntries,
  type LedgerVerdict,
} from "../ledger.ts";

// The cross-agent ledger tool — Chime's peer to cool-workflow's `cw ledger`. It
// speaks cw's exact, self-verifying entry format (sha256 content digest,
// content-addressed `ldg-<hex>` id), so the two agents hand each other change
// PROPOSALS and review VERDICTS as verifiable data, not chat:
//
//   cw:    cw ledger propose --from cool-workflow --to chime ... > proposal.json
//   chime: ledger verify (proposal.json)   -> fail-closed check before acting
//   chime: ledger review --verdict approved -> a sealed verdict cw can verify
//
// Read-only on the user's project code: `verify`/`list` only READ (an entry, or a
// shared handoff-repo directory); `propose`/`review` only BUILD a sealed entry and
// RETURN it as data for the operator to relay — Chime writes nothing and mutates
// no repo. (Chime's older `handoff` tool is a separate, local consensus board;
// this `ledger` is the interop channel with cw. Same split cw itself keeps between
// `cw handoff` and `cw ledger`.)

const inputSchema: JsonSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["verify", "list", "propose", "review"],
      description:
        "verify = fail-closed check one entry before acting; list = verify a shared ledger directory (an inbox); propose = mint a sealed change proposal; review = mint a sealed verdict",
    },
    entry: {
      description: "verify: the ledger entry to check — a JSON object or a JSON string (use this OR `file`)",
    },
    file: { type: "string", description: "verify: a path to a ledger entry JSON file to read and check" },
    dir: { type: "string", description: "list: a ledger directory (the working tree of a shared handoff repo) to verify" },
    dirs: {
      type: "array",
      items: { type: "string" },
      description: "list: two or more mirror directories to union-verify as one inbox (redundant hosts)",
    },
    from: { type: "string", description: "propose/review: the authoring agent/repo (default: chime)" },
    to: { type: "string", description: "propose/review: the receiving agent/repo (default: cool-workflow)" },
    title: { type: "string", description: "propose: a one-line title for the change" },
    rationale: { type: "string", description: "propose: why the change is worth making" },
    files: { type: "array", items: { type: "string" }, description: "propose: the files the change touches" },
    diff: { type: "string", description: "propose: a suggested patch/diff (optional)" },
    target: { type: "string", description: "review: the proposal id (ldg-…) or a PR ref being reviewed" },
    verdict: { type: "string", enum: ["approved", "rejected"], description: "review: the verdict" },
    findings: { type: "array", items: { type: "string" }, description: "review: notes backing the verdict" },
  },
  required: ["action"],
  additionalProperties: false,
};

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function handler(input: Record<string, unknown>, ctx: HandlerContext): ToolResultPayload {
  const action = String(input.action ?? "");
  const now = ctx.now().toISOString();
  const from = String(input.from ?? "").trim() || "chime";
  const to = String(input.to ?? "").trim() || "cool-workflow";

  if (action === "verify") {
    // Read one entry from `file` (read-only) or take it inline from `entry`
    // (object or JSON string). A non-JSON / unreadable input is itself a
    // fail-closed refusal, reported as verified:false — never a crash.
    const file = String(input.file ?? "").trim();
    let raw: unknown;
    if (file) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch (e) {
        return { ok: true, action, verified: false, id: null, kind: null, failedChecks: [{ name: "read", code: "ledger-file-unreadable", detail: e instanceof Error ? e.message : String(e) }] };
      }
      try {
        raw = JSON.parse(text);
      } catch {
        return { ok: true, action, verified: false, id: null, kind: null, failedChecks: [{ name: "parse", code: "ledger-bad-json" }] };
      }
    } else if (input.entry !== undefined) {
      if (typeof input.entry === "string") {
        try {
          raw = JSON.parse(input.entry);
        } catch {
          return { ok: true, action, verified: false, id: null, kind: null, failedChecks: [{ name: "parse", code: "ledger-bad-json" }] };
        }
      } else {
        raw = input.entry;
      }
    } else {
      return { ok: false, action, error: "verify needs `entry` (a JSON object/string) or `file` (a path)" };
    }
    const result = verifyLedgerEntry(raw);
    return { ok: true, action, verified: result.ok, id: result.id, kind: result.kind, failedChecks: result.failedChecks, checks: result.checks };
  }

  if (action === "list") {
    // `dirs` (2+) union-verifies mirrors; a single `dir`/`dirs[0]` keeps the
    // single-directory shape (POLA — same as `cw ledger list`).
    const dirs = strList(input.dirs);
    const single = String(input.dir ?? "").trim();
    if (dirs.length > 1) {
      const union = unionLedgerEntries(dirs);
      return { ok: true, action, ...union };
    }
    const dir = single || dirs[0] || "";
    if (!dir) return { ok: false, action, error: "list needs `dir` (a ledger directory) or `dirs` (mirror directories)" };
    const result = listLedgerEntries(dir);
    return { ok: true, action, ...result };
  }

  if (action === "propose") {
    const title = String(input.title ?? "").trim();
    const rationale = String(input.rationale ?? "").trim();
    if (!title) return { ok: false, action, error: "propose requires a title" };
    if (!rationale) return { ok: false, action, error: "propose requires a rationale" };
    const entry = buildLedgerProposal({
      from,
      to,
      title,
      rationale,
      targetFiles: strList(input.files),
      suggestedDiff: String(input.diff ?? ""),
      createdAt: now,
    });
    return { ok: true, action, id: entry.id, entry };
  }

  if (action === "review") {
    const target = String(input.target ?? "").trim();
    const verdictRaw = String(input.verdict ?? "").trim().toUpperCase();
    if (!target) return { ok: false, action, error: "review requires `target` (a proposal id or PR ref)" };
    if (verdictRaw !== "APPROVED" && verdictRaw !== "REJECTED") {
      return { ok: false, action, error: `verdict must be approved|rejected, got ${JSON.stringify(input.verdict ?? "")}` };
    }
    const entry = buildLedgerReview({
      from,
      to,
      target,
      verdict: verdictRaw as LedgerVerdict,
      findings: strList(input.findings),
      createdAt: now,
    });
    return { ok: true, action, id: entry.id, entry };
  }

  return { ok: false, action, error: `unknown action: ${action} (expected verify|list|propose|review)` };
}

export const ledger: Capability = {
  name: "ledger",
  description:
    "The cross-agent handoff ledger — how Chime interoperates with cool-workflow's `cw ledger`: two agents scoped to two repos hand each other a change PROPOSAL or a review VERDICT as VERIFIABLE data (a self-contained JSON entry with a sha256 content digest and a content-addressed ldg-… id), not chat. action=verify checks one entry FAIL-CLOSED before acting (from `entry` inline or a `file` path); a tampered or malformed entry is refused (verified:false). action=list verifies a whole ledger `dir` (a shared handoff repo's working tree) as an inbox, or union-verifies mirror `dirs`; allOk is false if ANY entry fails. action=propose mints a sealed proposal (from/to/title/rationale/files/diff). action=review mints a sealed verdict (target + approved|rejected + findings). Strictly read-only on your project code: verify/list only read, propose/review only return a sealed entry for you to relay. (Distinct from Chime's local `handoff` consensus board.)",
  inputSchema,
  handler,
};
