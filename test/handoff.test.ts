import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handoff, parseLedger, nextId, statusFromVerdict, normalizeAgent, consensus, ledgerPath, type Entry } from "../src/tools/handoff.ts";
import type { HandlerContext, ToolResultPayload } from "../src/types.ts";

function ctx(home: string, when = new Date("2026-07-01T00:00:00Z")): HandlerContext {
  return {
    runCommand: () => {
      throw new Error("handoff tool must not shell out");
    },
    env: {},
    now: () => when,
    home,
  };
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "chime-handoff-"));
}

// The handler is sync, but its type is `ToolResultPayload | Promise<…>`; awaiting
// unwraps it to a plain payload (the same seam memory.test.ts uses).
async function call(input: Record<string, unknown>, c: HandlerContext): Promise<ToolResultPayload> {
  return handoff.handler(input, c);
}

// --- pure helpers -----------------------------------------------------------

test("parseLedger: junk / missing yields [] (never throws)", () => {
  assert.deepEqual(parseLedger("not json"), []);
  assert.deepEqual(parseLedger("{}"), []);
  assert.deepEqual(parseLedger('[{"no":"id"}]'), []);
});

test("nextId: per-kind sequential ids", () => {
  const ledger: Entry[] = [
    { id: "P1", kind: "proposal", from: "chime", to: "claude", title: "a", status: "open", createdAt: "" },
    { id: "R1", kind: "review", from: "chime", to: "claude", title: "b", status: "done", createdAt: "" },
  ];
  assert.equal(nextId(ledger, "proposal"), "P2");
  assert.equal(nextId(ledger, "review"), "R2");
  assert.equal(nextId([], "proposal"), "P1");
});

test("statusFromVerdict: approve->accepted, request-changes->changes-requested, comment->open", () => {
  assert.equal(statusFromVerdict("approve"), "accepted");
  assert.equal(statusFromVerdict("request-changes"), "changes-requested");
  assert.equal(statusFromVerdict("comment"), "open");
});

test("normalizeAgent: slugifies any platform id, falls back when empty", () => {
  assert.equal(normalizeAgent("Codex"), "codex");
  assert.equal(normalizeAgent("DeepSeek R1"), "deepseek-r1");
  assert.equal(normalizeAgent("  "), "");
  assert.equal(normalizeAgent(undefined, "chime"), "chime");
  assert.equal(normalizeAgent(42, "claude"), "claude");
});

test("consensus: net of approvals over change-requests decides the panel verdict", () => {
  const mk = (from: string, verdict: "approve" | "request-changes" | "comment"): Entry => ({
    id: "R", kind: "review", from, to: "all", title: "", about: "P1", verdict, status: "done", createdAt: "",
  });
  // 3 approve + 1 request-changes -> net +2 -> accepted; reviewers listed
  const c = consensus([mk("claude", "approve"), mk("codex", "approve"), mk("gemini", "approve"), mk("deepseek", "request-changes")]);
  assert.equal(c.verdict, "accepted");
  assert.equal(c.approve, 3);
  assert.equal(c.requestChanges, 1);
  assert.deepEqual(c.reviewers, ["claude", "codex", "gemini", "deepseek"]);
  // a lone block ties it back open; a net-negative blocks
  assert.equal(consensus([mk("a", "approve"), mk("b", "request-changes")]).verdict, "open");
  assert.equal(consensus([mk("a", "request-changes")]).verdict, "changes-requested");
  assert.equal(consensus([mk("a", "comment")]).verdict, "open");
});

// --- propose ----------------------------------------------------------------

test("propose: writes a proposal entry and persists the ledger", async () => {
  const home = tempHome();
  const r = await call(
    { action: "propose", title: "add a CI probe", body: "detect .github/workflows", target: ["src/tools/project-doctor.ts"], ref: "claude/ci-probe" },
    ctx(home),
  );
  assert.equal(r.ok, true);
  assert.equal(r.id, "P1");
  assert.ok(existsSync(ledgerPath(home)));
  const saved = parseLedger(readFileSync(ledgerPath(home), "utf8"));
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.kind, "proposal");
  assert.equal(saved[0]!.from, "chime");
  assert.equal(saved[0]!.to, "claude");
  assert.equal(saved[0]!.status, "open");
  assert.deepEqual(saved[0]!.target, ["src/tools/project-doctor.ts"]);
  assert.equal(saved[0]!.createdAt, "2026-07-01T00:00:00.000Z");
});

test("propose: missing title fails closed, writes nothing", async () => {
  const home = tempHome();
  const r = await call({ action: "propose", body: "no title" }, ctx(home));
  assert.equal(r.ok, false);
  assert.ok(!existsSync(ledgerPath(home)));
});

// --- review round-trip ------------------------------------------------------

test("review: an approve advances the targeted proposal to accepted", async () => {
  const home = tempHome();
  await call({ action: "propose", title: "add a CI probe" }, ctx(home)); // P1
  const r = await call({ action: "review", about: "P1", verdict: "approve", body: "LGTM" }, ctx(home));
  assert.equal(r.ok, true);
  assert.equal(r.id, "R1");
  assert.deepEqual(r.advanced, { proposal: "P1", status: "accepted", reviewers: ["chime"] });

  const saved = parseLedger(readFileSync(ledgerPath(home), "utf8"));
  const p1 = saved.find((e) => e.id === "P1")!;
  const r1 = saved.find((e) => e.id === "R1")!;
  assert.equal(p1.status, "accepted");
  assert.equal(r1.kind, "review");
  assert.equal(r1.about, "P1");
  assert.equal(r1.verdict, "approve");
});

test("review: request-changes marks the proposal changes-requested", async () => {
  const home = tempHome();
  await call({ action: "propose", title: "risky change" }, ctx(home)); // P1
  const r = await call({ action: "review", about: "P1", verdict: "request-changes" }, ctx(home));
  assert.deepEqual(r.advanced, { proposal: "P1", status: "changes-requested", reviewers: ["chime"] });
});

test("multi-agent: codex proposes, a panel of agents co-reviews, consensus advances it", async () => {
  const home = tempHome();
  // Codex proposes to everyone
  const p = await call({ action: "propose", from: "codex", to: "all", title: "unify retry/backoff in http.ts" }, ctx(home));
  assert.equal((p.entry as Entry).from, "codex");
  assert.equal((p.entry as Entry).to, "all");

  // Claude, Gemini approve; DeepSeek requests changes -> net +1 -> accepted
  await call({ action: "review", from: "claude", about: "P1", verdict: "approve" }, ctx(home));
  await call({ action: "review", from: "gemini", about: "P1", verdict: "approve" }, ctx(home));
  const last = await call({ action: "review", from: "deepseek", about: "P1", verdict: "request-changes" }, ctx(home));
  assert.equal((last.advanced as { status: string }).status, "accepted");
  assert.deepEqual((last.advanced as { reviewers: string[] }).reviewers, ["claude", "gemini", "deepseek"]);
});

test("status: reports a proposal with its review panel and consensus", async () => {
  const home = tempHome();
  await call({ action: "propose", from: "chime", to: "all", title: "add a CI probe" }, ctx(home)); // P1
  await call({ action: "review", from: "claude", about: "P1", verdict: "approve" }, ctx(home));
  await call({ action: "review", from: "codex", about: "P1", verdict: "request-changes" }, ctx(home));
  const s = await call({ action: "status", about: "P1" }, ctx(home));
  assert.equal(s.ok, true);
  assert.equal((s.proposal as Entry).id, "P1");
  assert.equal((s.reviews as Entry[]).length, 2);
  assert.equal((s.consensus as { verdict: string }).verdict, "open"); // 1 vs 1 -> tie -> open
});

test("status: missing about fails closed", async () => {
  assert.equal((await call({ action: "status" }, ctx(tempHome()))).ok, false);
});

test("review: about an external PR ref records the verdict without advancing anything", async () => {
  const home = tempHome();
  const r = await call({ action: "review", about: "PR#4", verdict: "comment", body: "one nit" }, ctx(home));
  assert.equal(r.ok, true);
  assert.equal(r.advanced, undefined);
  const saved = parseLedger(readFileSync(ledgerPath(home), "utf8"));
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.about, "PR#4");
});

test("review: missing about or bad verdict fails closed", async () => {
  const home = tempHome();
  assert.equal((await call({ action: "review", verdict: "approve" }, ctx(home))).ok, false);
  assert.equal((await call({ action: "review", about: "P1", verdict: "nope" }, ctx(home))).ok, false);
});

// --- list & direction -------------------------------------------------------

test("list: filters by open / proposal / review", async () => {
  const home = tempHome();
  await call({ action: "propose", title: "one" }, ctx(home)); // P1 open
  await call({ action: "propose", title: "two" }, ctx(home)); // P2 open
  await call({ action: "review", about: "P1", verdict: "approve" }, ctx(home)); // R1, P1 -> accepted

  assert.equal((await call({ action: "list" }, ctx(home))).count, 3);
  assert.equal((await call({ action: "list", filter: "proposal" }, ctx(home))).count, 2);
  assert.equal((await call({ action: "list", filter: "review" }, ctx(home))).count, 1);
  assert.equal((await call({ action: "list", filter: "open" }, ctx(home))).count, 1); // only P2 stays open
});

test("propose: `to` can direct an entry the other way (claude -> chime is expressible)", async () => {
  const home = tempHome();
  const r = await call({ action: "propose", title: "chime, please add X", to: "chime" }, ctx(home));
  assert.equal((r.entry as Entry).to, "chime");
});

test("list on an empty ledger is ok and empty (not an error)", async () => {
  const r = await call({ action: "list" }, ctx(tempHome()));
  assert.equal(r.ok, true);
  assert.equal(r.count, 0);
});

test("unknown action fails closed", async () => {
  assert.equal((await call({ action: "frobnicate" }, ctx(tempHome()))).ok, false);
});
