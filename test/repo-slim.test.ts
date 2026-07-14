import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registryPath, type Project } from "../src/projects.ts";
import { repoSlim } from "../src/tools/repo-slim.ts";
import type { CommandResult, HandlerContext, RunCommand } from "../src/types.ts";

const FIXTURE: Project[] = [{ name: "demo", path: "Developer/demo", kind: "TS CLI", summary: "x", remotes: [] }];

function tempHome(): { home: string; repo: string } {
  const home = mkdtempSync(join(tmpdir(), "chime-slim-"));
  mkdirSync(join(home, ".chime"), { recursive: true });
  const repo = join(home, "Developer", "demo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(registryPath(home), JSON.stringify(FIXTURE));
  return { home, repo };
}

// Mocks `git ls-files` to return exactly the paths the test created — repo_slim's
// own scan otherwise reads real file content off disk via node:fs, same split as
// disk-maintenance.ts (shell only for the one git call, plain fs for everything else).
function ctx(home: string, trackedFiles: string[]): HandlerContext {
  const runCommand: RunCommand = (cmd, args): CommandResult => {
    if (cmd === "git" && args.includes("ls-files")) return { status: 0, stdout: trackedFiles.join("\n") + "\n", stderr: "" };
    return { status: 127, stdout: "", stderr: "unexpected cmd" };
  };
  return { home, env: {}, now: () => new Date(0), runCommand };
}

function write(repo: string, rel: string, content: string): void {
  const full = join(repo, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function findingFor(findings: unknown[], path: string): Record<string, unknown> {
  const f = (findings as Record<string, unknown>[]).find((x) => x.path === path);
  assert.ok(f, `no finding for ${path}`);
  return f!;
}

test("repo_slim: name is required", async () => {
  const { home } = tempHome();
  const r = await repoSlim.handler({ action: "scan", name: "  " }, ctx(home, []));
  assert.equal(r.ok, false);
  assert.match(String(r.error), /name is required/);
});

test("repo_slim: unknown project fails closed", async () => {
  const { home } = tempHome();
  const r = await repoSlim.handler({ action: "scan", name: "nope" }, ctx(home, []));
  assert.equal(r.ok, false);
  assert.match(String(r.error), /unknown project/);
});

test("scan flags an unreferenced script under scripts/ as orphan-tooling", async () => {
  const { home, repo } = tempHome();
  write(repo, "scripts/old-migrate.sh", "#!/bin/sh\necho migrating\n");
  write(repo, "src/index.ts", "console.log('hi');\n");
  const r = await repoSlim.handler({ action: "scan", name: "demo" }, ctx(home, ["scripts/old-migrate.sh", "src/index.ts"]));
  assert.equal(r.ok, true);
  const f = findingFor(r.findings as unknown[], "scripts/old-migrate.sh");
  assert.equal(f.verdict, "delete");
  assert.equal(f.confidence, "high");
  assert.equal(f.rotClass, "orphan-tooling");
});

test("scan flags a short pointer doc as stub-copy", async () => {
  const { home, repo } = tempHome();
  write(repo, "docs/old-guide.md", "# Old Guide\n\nSee [the real guide](docs/real-guide.md) instead.\n");
  write(repo, "docs/real-guide.md", "# Real Guide\n\nThe actual content lives here, with plenty of detail.\n");
  const r = await repoSlim.handler({ action: "scan", name: "demo" }, ctx(home, ["docs/old-guide.md", "docs/real-guide.md"]));
  assert.equal(r.ok, true);
  const f = findingFor(r.findings as unknown[], "docs/old-guide.md");
  assert.equal(f.verdict, "delete");
  assert.equal(f.rotClass, "stub-copy");
});

test("scan never flags an append-only audit record", async () => {
  const { home, repo } = tempHome();
  write(repo, "audit/2026-07-01.md", "# Audit\n\nNothing here references anything else.\n");
  write(repo, "CHANGELOG.md", "# Changelog\n\n## 0.0.1\n- first release\n");
  const r = await repoSlim.handler({ action: "scan", name: "demo" }, ctx(home, ["audit/2026-07-01.md", "CHANGELOG.md"]));
  assert.equal(r.ok, true);
  assert.equal(findingFor(r.findings as unknown[], "audit/2026-07-01.md").verdict, "keep");
  assert.equal(findingFor(r.findings as unknown[], "CHANGELOG.md").verdict, "keep");
});

// Regression for a real bug found running scan against chime's own repo: every
// relative import here spells out the .ts extension (`from "./util.ts"`), and
// the old regex required the closing quote right after the bare basename, so it
// never matched — every real, actively-imported source file came back "review".
test("scan recognizes an import that spells out the file's own extension", async () => {
  const { home, repo } = tempHome();
  write(repo, "src/util.ts", "export function helper() { return 1; }\n");
  write(repo, "src/index.ts", "import { helper } from \"./util.ts\";\nhelper();\n");
  const r = await repoSlim.handler({ action: "scan", name: "demo" }, ctx(home, ["src/util.ts", "src/index.ts"]));
  assert.equal(r.ok, true);
  const f = findingFor(r.findings as unknown[], "src/util.ts");
  assert.equal(f.verdict, "keep");
  assert.equal(f.pin, "import-reference");
});

// Regression for the same real-repo run: root config/lockfiles and test entry
// points are never textually referenced anywhere, so without an explicit
// allowlist they landed in the review bucket on every single scan.
test("scan keeps root config files and test entry points without flagging them", async () => {
  const { home, repo } = tempHome();
  write(repo, "package.json", '{"name":"demo"}\n');
  write(repo, ".gitignore", "node_modules\n");
  write(repo, "tsconfig.json", "{}\n");
  write(repo, "test/util.test.ts", "// a test file nothing imports\n");
  const files = ["package.json", ".gitignore", "tsconfig.json", "test/util.test.ts"];
  const r = await repoSlim.handler({ action: "scan", name: "demo" }, ctx(home, files));
  assert.equal(r.ok, true);
  for (const path of files) assert.equal(findingFor(r.findings as unknown[], path).verdict, "keep", `${path} should be kept`);
});

test("scan keeps a root agent doc and a CI-referenced file without flagging them", async () => {
  const { home, repo } = tempHome();
  write(repo, "AGENTS.md", "# Agent rules\n\nBe nice.\n");
  write(repo, ".github/workflows/ci.yml", "jobs:\n  test:\n    steps:\n      - run: node scripts/check.js\n");
  write(repo, "scripts/check.js", "console.log('checking');\n");
  const r = await repoSlim.handler(
    { action: "scan", name: "demo" },
    ctx(home, ["AGENTS.md", ".github/workflows/ci.yml", "scripts/check.js"]),
  );
  assert.equal(r.ok, true);
  assert.equal(findingFor(r.findings as unknown[], "AGENTS.md").verdict, "keep");
  assert.equal(findingFor(r.findings as unknown[], "scripts/check.js").verdict, "keep");
});

// A fixture test elsewhere in the repo reads this file via readFileSync, but
// nothing imports/requires it, links to it, or execs it — the one pin class
// TODO.md calls out as not fully verifiable by static grep. Must come back
// low confidence and "review", never a confident "delete".
test("scan downgrades a content-pinned fixture file to low confidence instead of delete", async () => {
  const { home, repo } = tempHome();
  write(repo, "test/fixtures/sample-data.json", '{"a":1}\n');
  write(repo, "test/sample.test.ts", "const data = readFileSync('test/fixtures/sample-data.json', 'utf8');\nassert.ok(data);\n");
  const r = await repoSlim.handler(
    { action: "scan", name: "demo" },
    ctx(home, ["test/fixtures/sample-data.json", "test/sample.test.ts"]),
  );
  assert.equal(r.ok, true);
  const f = findingFor(r.findings as unknown[], "test/fixtures/sample-data.json");
  assert.equal(f.confidence, "low");
  assert.notEqual(f.verdict, "delete");
  assert.equal(f.pin, "possible-content-pin");
});

test("scan pairs two docs with the same normalized H1 title as duplicate-doc-pair", async () => {
  const { home, repo } = tempHome();
  write(repo, "docs/setup.md", "# Getting Started\n\nOld setup notes.\n");
  write(repo, "docs/setup-new.md", "# Getting Started\n\nNewer, more complete setup notes.\n");
  const r = await repoSlim.handler({ action: "scan", name: "demo" }, ctx(home, ["docs/setup.md", "docs/setup-new.md"]));
  assert.equal(r.ok, true);
  const f = findingFor(r.findings as unknown[], "docs/setup-new.md");
  assert.equal(f.verdict, "merge");
  assert.equal(f.rotClass, "duplicate-doc-pair");
  assert.equal(f.pairWith, "docs/setup.md");
});

test("plan groups only high-confidence findings into tier1/tier2 and excludes low-confidence ones", async () => {
  const { home, repo } = tempHome();
  write(repo, "scripts/dead.sh", "#!/bin/sh\necho dead\n");
  write(repo, "test/fixtures/sample-data.json", '{"a":1}\n');
  write(repo, "test/sample.test.ts", "readFileSync('test/fixtures/sample-data.json');\n");
  const files = ["scripts/dead.sh", "test/fixtures/sample-data.json", "test/sample.test.ts"];
  const r = await repoSlim.handler({ action: "plan", name: "demo" }, ctx(home, files));
  assert.equal(r.ok, true);
  const tiers = r.tiers as { tier1DeleteZeroConsumer: { path: string }[]; tier3FixStaleFacts: unknown[]; tier4HistoryPurge: unknown[] };
  assert.ok(tiers.tier1DeleteZeroConsumer.some((f) => f.path === "scripts/dead.sh"));
  assert.equal(tiers.tier1DeleteZeroConsumer.some((f) => f.path === "test/fixtures/sample-data.json"), false);
  assert.deepEqual(tiers.tier3FixStaleFacts, []);
  assert.deepEqual(tiers.tier4HistoryPurge, []);
  assert.ok((r.needsReview as { path: string }[]).some((f) => f.path === "test/fixtures/sample-data.json"));
  assert.match(String(r.planHash), /^sha256:/);
});

test("rules returns the exact File Lifecycle snippet and needs no project", async () => {
  const { home } = tempHome();
  const r = await repoSlim.handler({ action: "rules" }, ctx(home, []));
  assert.equal(r.ok, true);
  assert.equal(
    r.snippet,
    `## File Lifecycle rules (repo_slim)

- **Orphan tooling.** A script, helper, or fixture with no consumer — no import,
  no CI step, no doc link, no spawn/exec reference — gets deleted, not kept
  "just in case."
- **Superseded drafts.** Once a draft's deliverable ships, the draft is deleted,
  not archived alongside the shipped copy.
- **Version-era snapshots.** A prompt, note, or "pending" list tied to a shipped
  version is deleted once that version ships; it is not a permanent record.
- **Stub copies.** A file whose content lives elsewhere is deleted — one source
  and a link is the rule, not two copies of the same fact.
- **Exemption: append-only records.** Audit logs, changelogs, and other
  append-only records are never subject to the rules above; they are exempt by
  design.
`,
  );
});

test("plan's planHash is stable for the same tree and changes when the file set changes", async () => {
  const { home, repo } = tempHome();
  write(repo, "scripts/dead.sh", "#!/bin/sh\necho dead\n");
  const a = await repoSlim.handler({ action: "plan", name: "demo" }, ctx(home, ["scripts/dead.sh"]));
  const b = await repoSlim.handler({ action: "plan", name: "demo" }, ctx(home, ["scripts/dead.sh"]));
  assert.equal(a.planHash, b.planHash);

  write(repo, "scripts/also-dead.sh", "#!/bin/sh\necho also dead\n");
  const c = await repoSlim.handler({ action: "plan", name: "demo" }, ctx(home, ["scripts/dead.sh", "scripts/also-dead.sh"]));
  assert.notEqual(c.planHash, a.planHash);
});

test("handoff without planHash is refused and proposes nothing", async () => {
  const { home, repo } = tempHome();
  write(repo, "scripts/dead.sh", "#!/bin/sh\necho dead\n");
  const r = await repoSlim.handler({ action: "handoff", name: "demo" }, ctx(home, ["scripts/dead.sh"]));
  assert.equal(r.ok, false);
  assert.match(String(r.error), /planHash/);
  assert.equal(r.proposals, undefined);
});

test("handoff with a stale planHash after the tree changed is refused, forcing a fresh plan", async () => {
  const { home, repo } = tempHome();
  write(repo, "scripts/dead.sh", "#!/bin/sh\necho dead\n");
  const plan = await repoSlim.handler({ action: "plan", name: "demo" }, ctx(home, ["scripts/dead.sh"]));
  assert.equal(plan.ok, true);
  const staleHash = plan.planHash as string;

  write(repo, "scripts/also-dead.sh", "#!/bin/sh\necho also dead\n");
  const stale = await repoSlim.handler(
    { action: "handoff", name: "demo", planHash: staleHash },
    ctx(home, ["scripts/dead.sh", "scripts/also-dead.sh"]),
  );
  assert.equal(stale.ok, false);
  assert.match(String(stale.error), /planHash does not match|plan again/);
  assert.equal(stale.proposals, undefined);

  // Boring recovery: a fresh plan + its planHash succeeds.
  const freshPlan = await repoSlim.handler({ action: "plan", name: "demo" }, ctx(home, ["scripts/dead.sh", "scripts/also-dead.sh"]));
  const freshHandoff = await repoSlim.handler(
    { action: "handoff", name: "demo", planHash: freshPlan.planHash },
    ctx(home, ["scripts/dead.sh", "scripts/also-dead.sh"]),
  );
  assert.equal(freshHandoff.ok, true);
});

test("handoff with a matching planHash emits one sealed proposal per non-empty tier, draft by default", async () => {
  const { home, repo } = tempHome();
  write(repo, "scripts/dead.sh", "#!/bin/sh\necho dead\n");
  write(repo, "docs/setup.md", "# Getting Started\n\nOld setup notes.\n");
  write(repo, "docs/setup-new.md", "# Getting Started\n\nNewer, more complete setup notes.\n");
  const files = ["scripts/dead.sh", "docs/setup.md", "docs/setup-new.md"];

  const plan = await repoSlim.handler({ action: "plan", name: "demo" }, ctx(home, files));
  assert.equal(plan.ok, true);

  const r = await repoSlim.handler({ action: "handoff", name: "demo", planHash: plan.planHash }, ctx(home, files));
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.match(String(r.status), /^draft/);

  const proposals = r.proposals as Record<string, unknown>[];
  assert.equal(proposals.length, 2);
  const deleteProposal = proposals.find((p) => String(p.title).includes("delete"))!;
  const mergeProposal = proposals.find((p) => String(p.title).includes("merge"))!;
  assert.deepEqual(deleteProposal.targetFiles, ["scripts/dead.sh"]);
  // Both members of the pair carry the merge verdict (each pairWith-linked to the
  // other), so the batch's targetFiles covers both files a real merge PR touches.
  assert.deepEqual(mergeProposal.targetFiles, ["docs/setup.md", "docs/setup-new.md"]);
  assert.equal(deleteProposal.from, "chime");
  assert.equal(deleteProposal.to, "cool-workflow");
  assert.match(String(deleteProposal.id), /^ldg-/);
  assert.match(String(deleteProposal.rationale), /full test suite/);
});

test("handoff dryRun:false marks proposals ready-to-relay without sending anything", async () => {
  const { home, repo } = tempHome();
  write(repo, "scripts/dead.sh", "#!/bin/sh\necho dead\n");
  const files = ["scripts/dead.sh"];
  const plan = await repoSlim.handler({ action: "plan", name: "demo" }, ctx(home, files));
  const r = await repoSlim.handler({ action: "handoff", name: "demo", planHash: plan.planHash, dryRun: false, from: "chime", to: "cool-workflow" }, ctx(home, files));
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, false);
  assert.match(String(r.status), /^ready-to-relay/);
});

test("handoff with nothing high-confidence to propose returns an empty proposals array, not an error", async () => {
  const { home, repo } = tempHome();
  write(repo, "README.md", "# demo\n");
  const files = ["README.md"];
  const plan = await repoSlim.handler({ action: "plan", name: "demo" }, ctx(home, files));
  const r = await repoSlim.handler({ action: "handoff", name: "demo", planHash: plan.planHash }, ctx(home, files));
  assert.equal(r.ok, true);
  assert.deepEqual(r.proposals, []);
  assert.match(String(r.note), /nothing high-confidence/);
});
