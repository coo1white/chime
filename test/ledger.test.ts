import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeLedgerDigest,
  buildLedgerProposal,
  buildLedgerReview,
  verifyLedgerEntry,
  listLedgerEntries,
  unionLedgerEntries,
  type LedgerEntry,
} from "../src/ledger.ts";
import { ledger } from "../src/tools/ledger.ts";
import type { HandlerContext, ToolResultPayload } from "../src/types.ts";

const WHEN = "2026-07-01T00:00:00.000Z";

function ctx(home = tempDir(), when = new Date(WHEN)): HandlerContext {
  return {
    runCommand: () => {
      throw new Error("ledger tool must not shell out");
    },
    env: {},
    now: () => when,
    home,
  };
}
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "chime-ledger-"));
}
async function call(input: Record<string, unknown>, c: HandlerContext = ctx()): Promise<ToolResultPayload> {
  return ledger.handler(input, c);
}
function writeEntry(dir: string, entry: LedgerEntry): void {
  writeFileSync(join(dir, `${entry.id}.json`), JSON.stringify(entry, null, 2));
}

// ---------------------------------------------------------------------------
// GENUINE cool-workflow fixtures — these two entries were produced by cw's OWN
// compiled `dist/ledger.js` kernel (origin/main). If Chime's port verifies them
// ok:true AND reproduces their id/digest from the same input, the sha256 digest
// is byte-identical across the two repos and the handoff actually interoperates.
// (Entries are immutable + content-addressed, so these fixtures never rot.)
// ---------------------------------------------------------------------------

const CW_PROPOSAL: LedgerEntry = {
  kind: "proposal",
  schemaVersion: 1,
  from: "cool-workflow",
  to: "chime",
  title: "Add retry to the fetch path",
  rationale: "the network is flaky under load",
  targetFiles: ["src/net.ts"],
  suggestedDiff: "@@ -1 +1 @@",
  createdAt: WHEN,
  id: "ldg-6fd2a38a8a1d2b8c",
  digest: "sha256:6fd2a38a8a1d2b8ce8e00b4c7bb50468c7040bbf06cae06f706890974b8a62c8",
};
const CW_REVIEW: LedgerEntry = {
  kind: "review",
  schemaVersion: 1,
  from: "cool-workflow",
  to: "chime",
  target: "ldg-6fd2a38a8a1d2b8c",
  verdict: "APPROVED",
  findings: ["tests pass", "scope ok"],
  createdAt: WHEN,
  id: "ldg-cf82d6ebba60025b",
  digest: "sha256:cf82d6ebba60025b353a5502fcd9db408d6084f94e0514b81d9e3716abbca37a",
};

test("INTEROP: Chime verifies genuine cw-produced entries fail-closed → ok", () => {
  assert.equal(verifyLedgerEntry(CW_PROPOSAL).ok, true);
  assert.equal(verifyLedgerEntry(CW_REVIEW).ok, true);
});

test("INTEROP: Chime reproduces cw's exact id + digest from the same input", () => {
  const p = buildLedgerProposal({
    from: "cool-workflow",
    to: "chime",
    title: "Add retry to the fetch path",
    rationale: "the network is flaky under load",
    targetFiles: ["src/net.ts"],
    suggestedDiff: "@@ -1 +1 @@",
    createdAt: WHEN,
  });
  assert.equal(p.id, CW_PROPOSAL.id);
  assert.equal(p.digest, CW_PROPOSAL.digest);
  const r = buildLedgerReview({
    from: "cool-workflow",
    to: "chime",
    target: CW_PROPOSAL.id,
    verdict: "APPROVED",
    findings: ["tests pass", "scope ok"],
    createdAt: WHEN,
  });
  assert.equal(r.id, CW_REVIEW.id);
  assert.equal(r.digest, CW_REVIEW.digest);
});

test("INTEROP: one flipped byte in a cw entry is refused (digest mismatch)", () => {
  const tampered = { ...CW_PROPOSAL, title: "Add retry to the fetch path!" };
  const res = verifyLedgerEntry(tampered);
  assert.equal(res.ok, false);
  assert.equal(res.failedChecks[0].code, "ledger-digest-mismatch");
});

// ---------------------------------------------------------------------------
// Kernel — digest, sealing, and fail-closed verification.
// ---------------------------------------------------------------------------

test("computeLedgerDigest is content-only (key order does not matter)", () => {
  const a = { kind: "proposal" as const, schemaVersion: 1 as const, from: "x", to: "y", title: "t", rationale: "r", targetFiles: ["a"], suggestedDiff: "", createdAt: WHEN };
  const b = { createdAt: WHEN, suggestedDiff: "", targetFiles: ["a"], rationale: "r", title: "t", to: "y", from: "x", schemaVersion: 1 as const, kind: "proposal" as const };
  assert.equal(computeLedgerDigest(a), computeLedgerDigest(b));
});

test("build seals a proposal that verifies; id is ldg-<first16 of digest>", () => {
  const p = buildLedgerProposal({ from: "chime", to: "cool-workflow", title: "t", rationale: "r", targetFiles: [], createdAt: WHEN });
  assert.equal(p.suggestedDiff, ""); // absent diff defaults to ""
  assert.equal(p.id, `ldg-${p.digest.replace(/^sha256:/, "").slice(0, 16)}`);
  assert.equal(verifyLedgerEntry(p).ok, true);
});

test("build seals a review that verifies", () => {
  const r = buildLedgerReview({ from: "chime", to: "cool-workflow", target: "ldg-abc", verdict: "REJECTED", findings: ["nope"], createdAt: WHEN });
  assert.equal(verifyLedgerEntry(r).ok, true);
});

test("verify fail-closed codes", () => {
  const code = (raw: unknown) => verifyLedgerEntry(raw).failedChecks[0]?.code;
  assert.equal(code(null), "ledger-not-object");
  assert.equal(code("nope"), "ledger-not-object");
  assert.equal(code({ kind: "x", schemaVersion: 1, digest: "d" }), "ledger-unknown-kind");
  assert.equal(code({ kind: "proposal", schemaVersion: 2, digest: "d" }), "ledger-bad-schema");
  assert.equal(code({ kind: "proposal", schemaVersion: 1 }), "ledger-missing-digest");
  assert.equal(code({ kind: "proposal", schemaVersion: 1, digest: "d", from: "a", to: "b", title: "t", rationale: "r", targetFiles: [] /* no suggestedDiff/createdAt */ }), "ledger-missing-field");

  const good = buildLedgerReview({ from: "a", to: "b", target: "t", verdict: "APPROVED", findings: [], createdAt: WHEN });
  assert.equal(verifyLedgerEntry({ ...good, verdict: "MAYBE" }).failedChecks[0]?.code, "ledger-bad-verdict"); // verdict shape is checked before the digest
  assert.equal(code({ ...good, digest: "sha256:deadbeef" }), "ledger-digest-mismatch"); // verdict intact → proceeds to digest
});

test("verify rejects a spoofed id (id not bound to the digest)", () => {
  const p = buildLedgerProposal({ from: "a", to: "b", title: "t", rationale: "r", targetFiles: [], createdAt: WHEN });
  const res = verifyLedgerEntry({ ...p, id: "ldg-0000000000000000" });
  assert.equal(res.ok, false);
  assert.equal(res.failedChecks[0].code, "ledger-id-mismatch");
});

test("verify rejects a review with a bad verdict shape (content intact)", () => {
  // Build the content ourselves so the digest matches but the verdict is invalid.
  const bad = { kind: "review", schemaVersion: 1, from: "a", to: "b", target: "t", verdict: "COMMENT", findings: [], createdAt: WHEN };
  const digest = computeLedgerDigest(bad as Omit<LedgerEntry, "id" | "digest">);
  const entry = { ...bad, digest, id: `ldg-${digest.replace(/^sha256:/, "").slice(0, 16)}` };
  assert.equal(verifyLedgerEntry(entry).failedChecks[0]?.code, "ledger-bad-verdict");
});

// ---------------------------------------------------------------------------
// SECURITY REGRESSION: on failure, verifyLedgerEntry must never echo back a
// raw, unverified field from the input. A malformed/unrelated JSON object read
// via `file`/`dir` must not have its content reflected into the response.
// ---------------------------------------------------------------------------

test("SECURITY: verify on an arbitrary non-ledger object never echoes raw fields on failure", () => {
  const raw = { id: "SECRET-1", kind: "not-a-real-kind" };
  const res = verifyLedgerEntry(raw);
  assert.equal(res.ok, false);
  assert.equal(res.id, null);
  assert.equal(res.kind, null);
  const haystacks = [
    ...res.checks.map((c) => c.detail ?? ""),
    ...res.failedChecks.map((c) => c.detail ?? ""),
  ];
  for (const s of haystacks) {
    assert.ok(!s.includes("SECRET-1"), `detail leaked raw id: ${s}`);
    assert.ok(!s.includes("not-a-real-kind"), `detail leaked raw kind: ${s}`);
  }
});

test("SECURITY: listLedgerEntries on a non-ledger JSON file never surfaces its raw from/to", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "leak.json"), JSON.stringify({ from: "victim@internal", to: "root" }));
  const res = listLedgerEntries(dir);
  assert.equal(res.allOk, false);
  assert.equal(res.entries.length, 1);
  assert.equal(res.entries[0].from, null);
  assert.equal(res.entries[0].to, null);
});

test("SECURITY: a legitimate proposal/review still verifies ok with real id/kind surfaced", () => {
  const p = buildLedgerProposal({ from: "chime", to: "cool-workflow", title: "t", rationale: "r", targetFiles: [], createdAt: WHEN });
  const pRes = verifyLedgerEntry(p);
  assert.equal(pRes.ok, true);
  assert.equal(pRes.id, p.id);
  assert.equal(pRes.kind, "proposal");

  const r = buildLedgerReview({ from: "chime", to: "cool-workflow", target: "ldg-abc", verdict: "REJECTED", findings: ["nope"], createdAt: WHEN });
  const rRes = verifyLedgerEntry(r);
  assert.equal(rRes.ok, true);
  assert.equal(rRes.id, r.id);
  assert.equal(rRes.kind, "review");

  const dir = tempDir();
  writeEntry(dir, p);
  const listed = listLedgerEntries(dir);
  assert.equal(listed.allOk, true);
  assert.equal(listed.entries[0].id, p.id);
  assert.equal(listed.entries[0].kind, "proposal");
  assert.equal(listed.entries[0].from, "chime");
  assert.equal(listed.entries[0].to, "cool-workflow");
});

// ---------------------------------------------------------------------------
// Git-transport helpers — verify a directory / union of mirrors, fail-closed.
// ---------------------------------------------------------------------------

test("listLedgerEntries: all-good dir is allOk; one tampered entry fails the batch", () => {
  const dir = tempDir();
  writeEntry(dir, CW_PROPOSAL);
  writeEntry(dir, CW_REVIEW);
  assert.equal(listLedgerEntries(dir).allOk, true);
  // drop a tampered entry in
  writeFileSync(join(dir, "bad.json"), JSON.stringify({ ...CW_PROPOSAL, title: "changed" }));
  const after = listLedgerEntries(dir);
  assert.equal(after.allOk, false);
  assert.equal(after.count, 3);
});

test("listLedgerEntries: unreadable dir fails closed", () => {
  const res = listLedgerEntries(join(tempDir(), "does-not-exist"));
  assert.equal(res.allOk, false);
  assert.equal(res.entries[0].failedChecks[0].code, "ledger-dir-unreadable");
});

test("unionLedgerEntries: same entry mirrored to two dirs dedupes, records both", () => {
  const a = tempDir();
  const b = tempDir();
  writeEntry(a, CW_PROPOSAL);
  writeEntry(b, CW_PROPOSAL); // same content-addressed id in both mirrors
  writeEntry(b, CW_REVIEW);
  const u = unionLedgerEntries([a, b]);
  assert.equal(u.allOk, true);
  assert.equal(u.count, 2); // proposal collapses to one, plus the review
  const prop = u.entries.find((e) => e.id === CW_PROPOSAL.id);
  assert.deepEqual(prop?.dirs, [a, b]);
});

// ---------------------------------------------------------------------------
// The tool surface — verify / list / propose / review through the handler.
// ---------------------------------------------------------------------------

test("tool propose → sealed entry that verifies; defaults from=chime to=cool-workflow", async () => {
  const r = await call({ action: "propose", title: "Add a retry", rationale: "flaky net", files: ["src/net.ts"] });
  assert.equal(r.ok, true);
  const entry = r.entry as LedgerEntry;
  assert.equal(entry.from, "chime");
  assert.equal(entry.to, "cool-workflow");
  assert.equal(verifyLedgerEntry(entry).ok, true);
  assert.equal(r.id, entry.id);
});

test("tool review needs a valid verdict; approved|rejected accepted case-insensitively", async () => {
  const bad = await call({ action: "review", target: "ldg-x", verdict: "maybe" });
  assert.equal(bad.ok, false);
  const good = await call({ action: "review", target: "ldg-x", verdict: "Approved", findings: ["ok"] });
  assert.equal(good.ok, true);
  assert.equal((good.entry as { verdict: string }).verdict, "APPROVED");
});

test("tool verify: inline object, JSON string, and a tampered entry", async () => {
  const ok = await call({ action: "verify", entry: CW_PROPOSAL });
  assert.equal(ok.ok, true);
  assert.equal(ok.verified, true);
  assert.equal(ok.id, CW_PROPOSAL.id);

  const asString = await call({ action: "verify", entry: JSON.stringify(CW_REVIEW) });
  assert.equal(asString.verified, true);

  const tampered = await call({ action: "verify", entry: { ...CW_PROPOSAL, rationale: "changed" } });
  assert.equal(tampered.ok, true); // the tool ran fine…
  assert.equal(tampered.verified, false); // …and correctly refused the entry
  assert.equal((tampered.failedChecks as { code: string }[])[0].code, "ledger-digest-mismatch");

  const notJson = await call({ action: "verify", entry: "{not json" });
  assert.equal(notJson.verified, false);
  assert.equal((notJson.failedChecks as { code: string }[])[0].code, "ledger-bad-json");
});

test("tool verify: from a file on disk", async () => {
  const dir = tempDir();
  const file = join(dir, "proposal.json");
  writeFileSync(file, JSON.stringify(CW_PROPOSAL));
  const r = await call({ action: "verify", file });
  assert.equal(r.verified, true);
  const missing = await call({ action: "verify", file: join(dir, "nope.json") });
  assert.equal(missing.verified, false);
  assert.equal((missing.failedChecks as { code: string }[])[0].code, "ledger-file-unreadable");
});

test("tool list: single dir and mirror union through the handler", async () => {
  const a = tempDir();
  const b = tempDir();
  writeEntry(a, CW_PROPOSAL);
  writeEntry(b, CW_PROPOSAL);
  const single = await call({ action: "list", dir: a });
  assert.equal(single.ok, true);
  assert.equal(single.allOk, true);
  assert.equal(single.count, 1);
  const union = await call({ action: "list", dirs: [a, b] });
  assert.equal(union.allOk, true);
  assert.equal(union.count, 1);
  assert.deepEqual((union.dirs as string[]).sort(), [a, b].sort());
});

// A ctx with a custom env (the shared `ctx()` helper hard-codes env:{}).
function ctxEnv(env: Record<string, string | undefined>, home = tempDir()): HandlerContext {
  return {
    runCommand: () => {
      throw new Error("ledger tool must not shell out");
    },
    env,
    now: () => new Date(WHEN),
    home,
  };
}
function writeConfig(home: string, cfg: Record<string, unknown>): void {
  mkdirSync(join(home, ".chime"), { recursive: true });
  writeFileSync(join(home, ".chime", "config.json"), JSON.stringify(cfg));
}

test("tool list: no dir falls back to CHIME_HANDOFF_DIR (source=env)", async () => {
  const d = tempDir();
  writeEntry(d, CW_PROPOSAL);
  const res = await call({ action: "list" }, ctxEnv({ CHIME_HANDOFF_DIR: d }));
  assert.equal(res.ok, true);
  assert.equal(res.source, "env");
  assert.equal(res.dir, d);
  assert.equal(res.allOk, true);
  assert.equal(res.count, 1);
});

test("tool list: no dir falls back to ~/.chime/config.json handoffDir (source=config)", async () => {
  const d = tempDir();
  writeEntry(d, CW_PROPOSAL);
  const home = tempDir();
  writeConfig(home, { handoffDir: d });
  const res = await call({ action: "list" }, ctx(home));
  assert.equal(res.ok, true);
  assert.equal(res.source, "config");
  assert.equal(res.dir, d);
  assert.equal(res.count, 1);
});

test("tool list: an explicit dir wins over env/config (source=arg)", async () => {
  const argD = tempDir();
  writeEntry(argD, CW_PROPOSAL);
  const envD = tempDir(); // empty — must NOT be read
  const res = await call({ action: "list", dir: argD }, ctxEnv({ CHIME_HANDOFF_DIR: envD }));
  assert.equal(res.source, "arg");
  assert.equal(res.dir, argD);
  assert.equal(res.count, 1);
});

test("tool list: env CHIME_HANDOFF_DIR wins over config handoffDir", async () => {
  const envD = tempDir();
  writeEntry(envD, CW_PROPOSAL);
  const cfgD = tempDir(); // different, empty
  const home = tempDir();
  writeConfig(home, { handoffDir: cfgD });
  const res = await call({ action: "list" }, ctxEnv({ CHIME_HANDOFF_DIR: envD }, home));
  assert.equal(res.source, "env");
  assert.equal(res.dir, envD);
});

test("tool list: no dir and nothing configured fails closed with a helpful error", async () => {
  const res = await call({ action: "list" }, ctx()); // temp home, no config, empty env
  assert.equal(res.ok, false);
  assert.match(String(res.error), /CHIME_HANDOFF_DIR|handoffDir/);
});

test("tool list: a whitespace-only dirs[0] falls through to config, same as a whitespace dir", async () => {
  const d = tempDir();
  writeEntry(d, CW_PROPOSAL);
  const home = tempDir();
  writeConfig(home, { handoffDir: d });
  const viaDirs = await call({ action: "list", dirs: ["  "] }, ctx(home));
  const viaDir = await call({ action: "list", dir: "  " }, ctx(home));
  assert.equal(viaDirs.source, "config");
  assert.equal(viaDirs.ok, true);
  assert.equal(viaDirs.count, 1);
  assert.deepEqual(viaDirs, viaDir);
});

test("tool: bad input fails closed (dispatch marks is_error)", async () => {
  assert.equal((await call({ action: "verify" })).ok, false);
  assert.equal((await call({ action: "list" })).ok, false);
  assert.equal((await call({ action: "propose", title: "t" })).ok, false); // no rationale
  assert.equal((await call({ action: "nope" })).ok, false);
});
