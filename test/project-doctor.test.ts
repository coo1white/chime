import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  projectDoctor,
  diagnose,
  probe,
  scoreFindings,
  detectToolchain,
  SEVERITY_WEIGHT,
  type Finding,
} from "../src/tools/project-doctor.ts";
import type { CommandResult, HandlerContext, RunCommand } from "../src/types.ts";
import type { Project } from "../src/projects.ts";

// A HandlerContext whose git() answers come from a lookup keyed by the git
// subcommand, so each probe can be driven deterministically with no real git.
function gitCtx(home: string, replies: Record<string, CommandResult>, now = new Date("2026-07-01")): HandlerContext {
  const runCommand: RunCommand = (cmd, args): CommandResult => {
    if (cmd !== "git") return { status: 1, stdout: "", stderr: "not git" };
    const sub = args[2] ?? ""; // args = ["-C", path, <sub>, ...]
    return replies[sub] ?? { status: 1, stdout: "", stderr: `no reply for ${sub}` };
  };
  return { runCommand, env: {}, now: () => now, home };
}

const base: Project = { name: "demo", path: "Developer/demo", kind: "TS CLI", summary: "y", remotes: [], check: ["npm", "run", "check"] };

// A commit timestamp a couple of weeks before the fixed ctx.now() (2026-07-01) —
// "recent" for every probe except the staleness test, and independent of the
// real wall clock.
const RECENT = Math.floor(new Date("2026-06-15").getTime() / 1000);

// --- pure scoring -----------------------------------------------------------

test("scoreFindings: a clean repo scores 100 / grade A", () => {
  const findings: Finding[] = [
    { id: "git", severity: "ok", title: "" },
    { id: "readme", severity: "ok", title: "" },
  ];
  const { score, grade } = scoreFindings(findings);
  assert.equal(score, 100);
  assert.equal(grade, "A");
});

test("scoreFindings: penalties subtract by severity and floor at 0", () => {
  assert.equal(scoreFindings([{ id: "a", severity: "warn", title: "" }]).score, 100 - SEVERITY_WEIGHT.warn);
  assert.equal(scoreFindings([{ id: "a", severity: "fail", title: "" }]).score, 100 - SEVERITY_WEIGHT.fail);
  // ten fails would go negative — floored at 0.
  const many: Finding[] = Array.from({ length: 10 }, (_, i) => ({ id: String(i), severity: "fail" as const, title: "" }));
  assert.equal(scoreFindings(many).score, 0);
});

test("scoreFindings: grade bands (A/B/C/D/F)", () => {
  const grade = (n: number) => scoreFindings(Array.from({ length: n }, (_, i) => ({ id: String(i), severity: "warn" as const, title: "" }))).grade;
  assert.equal(grade(0), "A"); // 100
  assert.equal(grade(2), "B"); // 84
  assert.equal(grade(5), "C"); // 60
  assert.equal(grade(6), "D"); // 52
  assert.equal(grade(8), "F"); // 36
});

// --- toolchain detection ----------------------------------------------------

test("detectToolchain: recognizes Node, Rust, Go; unknown otherwise", () => {
  assert.equal(detectToolchain(new Set(["package.json"]))?.id, "node");
  assert.equal(detectToolchain(new Set(["Cargo.toml"]))?.id, "rust");
  assert.equal(detectToolchain(new Set(["go.mod"]))?.id, "go");
  assert.equal(detectToolchain(new Set(["notes.txt"])), undefined);
});

// --- probes drive findings --------------------------------------------------

test("probe: a pristine node repo yields only ok findings", () => {
  const files = new Set(["package.json", "package-lock.json", "README.md", ".gitignore", "LICENSE", ".gitlab-ci.yml"]);
  const ctx = gitCtx("/home", {
    "rev-parse": { status: 0, stdout: "true", stderr: "" },
    status: { status: 0, stdout: "", stderr: "" },
    "rev-list": { status: 0, stdout: "0\t0", stderr: "" },
    log: { status: 0, stdout: String(RECENT), stderr: "" },
    "ls-files": { status: 0, stdout: "", stderr: "" },
  });
  const findings = probe(base, ctx, files, "/home/Developer/demo");
  assert.ok(findings.every((f) => f.severity === "ok"), `all ok, got ${JSON.stringify(findings.filter((f) => f.severity !== "ok"))}`);
});

test("probe: unpushed commits and a dirty tree each warn with a fix", () => {
  const files = new Set(["package.json", "package-lock.json", "README.md", ".gitignore"]);
  const ctx = gitCtx("/home", {
    "rev-parse": { status: 0, stdout: "true", stderr: "" },
    status: { status: 0, stdout: " M src/x.ts", stderr: "" },
    "rev-list": { status: 0, stdout: "0\t3", stderr: "" }, // behind=0 ahead=3
    log: { status: 0, stdout: String(RECENT), stderr: "" },
    "ls-files": { status: 0, stdout: "", stderr: "" },
  });
  const findings = probe(base, ctx, files, "/home/Developer/demo");
  const sync = findings.find((f) => f.id === "sync")!;
  const clean = findings.find((f) => f.id === "clean-tree")!;
  assert.equal(sync.severity, "warn");
  assert.match(sync.title, /3 unpushed/);
  assert.equal(sync.fix, "git push");
  assert.equal(clean.severity, "warn");
});

test("probe: no .git -> a single 'not under version control' fail, git probes skipped", () => {
  const ctx = gitCtx("/home", { "rev-parse": { status: 128, stdout: "", stderr: "not a repo" } });
  const findings = probe(base, ctx, new Set(["README.md"]), "/home/Developer/demo");
  const gitF = findings.find((f) => f.id === "git")!;
  assert.equal(gitF.severity, "fail");
  assert.ok(!findings.some((f) => f.id === "sync"), "no sync probe without a repo");
});

test("probe: manifest without a lockfile warns; missing README/gitignore warn", () => {
  const files = new Set(["package.json"]); // no lock, no README, no .gitignore
  const ctx = gitCtx("/home", {
    "rev-parse": { status: 0, stdout: "true", stderr: "" },
    status: { status: 0, stdout: "", stderr: "" },
    "rev-list": { status: 1, stdout: "", stderr: "no upstream" },
    log: { status: 0, stdout: String(RECENT), stderr: "" },
    "ls-files": { status: 0, stdout: "", stderr: "" },
  });
  const findings = probe(base, ctx, files, "/home/Developer/demo");
  assert.equal(findings.find((f) => f.id === "lockfile")!.severity, "warn");
  assert.equal(findings.find((f) => f.id === "readme")!.severity, "warn");
  assert.equal(findings.find((f) => f.id === "gitignore")!.severity, "warn");
  assert.equal(findings.find((f) => f.id === "sync")!.severity, "skip"); // no upstream is not a defect
});

test("probe: a missing license warns; LICENSE/COPYING variants satisfy it", () => {
  const ctx = gitCtx("/home", { "rev-parse": { status: 128, stdout: "", stderr: "x" } });
  const missing = probe(base, ctx, new Set(["README.md"]), "/home/Developer/demo").find((f) => f.id === "license")!;
  assert.equal(missing.severity, "warn");
  assert.match(missing.title, /no license/i);

  for (const name of ["LICENSE", "LICENSE.md", "license.txt", "COPYING", "LICENCE"]) {
    const ok = probe(base, ctx, new Set([name]), "/home/Developer/demo").find((f) => f.id === "license")!;
    assert.equal(ok.severity, "ok", `${name} should satisfy the license probe`);
  }
});

test("probe: committed build artifacts warn with a git rm fix", () => {
  const files = new Set(["package.json", "package-lock.json", "README.md", ".gitignore"]);
  const ctx = gitCtx("/home", {
    "rev-parse": { status: 0, stdout: "true", stderr: "" },
    status: { status: 0, stdout: "", stderr: "" },
    "rev-list": { status: 0, stdout: "0\t0", stderr: "" },
    log: { status: 0, stdout: String(RECENT), stderr: "" },
    "ls-files": { status: 0, stdout: "node_modules/x/index.js\ndist/app.js", stderr: "" },
  });
  const artifacts = probe(base, ctx, files, "/home/Developer/demo").find((f) => f.id === "artifacts")!;
  assert.equal(artifacts.severity, "warn");
  assert.match(artifacts.fix ?? "", /git rm -r --cached/);
});

test("probe: a stale repo (last commit > 90d) warns", () => {
  const files = new Set(["package.json", "package-lock.json", "README.md", ".gitignore"]);
  const old = Math.floor(new Date("2026-01-01").getTime() / 1000); // ~181d before 2026-07-01
  const ctx = gitCtx("/home", {
    "rev-parse": { status: 0, stdout: "true", stderr: "" },
    status: { status: 0, stdout: "", stderr: "" },
    "rev-list": { status: 0, stdout: "0\t0", stderr: "" },
    log: { status: 0, stdout: String(old), stderr: "" },
    "ls-files": { status: 0, stdout: "", stderr: "" },
  });
  const stale = probe(base, ctx, files, "/home/Developer/demo").find((f) => f.id === "staleness")!;
  assert.equal(stale.severity, "warn");
  assert.match(stale.title, /no commits in \d+ days/);
});

test("probe: a project with no check gate warns", () => {
  const noCheck: Project = { ...base, check: undefined };
  const ctx = gitCtx("/home", { "rev-parse": { status: 128, stdout: "", stderr: "x" } });
  const wired = probe(noCheck, ctx, new Set(), "/home/Developer/demo").find((f) => f.id === "check-wired")!;
  assert.equal(wired.severity, "warn");
});

// --- diagnose over a real temp directory ------------------------------------

test("diagnose: fails closed when the project path does not exist", () => {
  const ctx = gitCtx("/no/such/home", {});
  const r = diagnose(base, ctx);
  assert.equal(r.ok, false);
  assert.match(String(r.error), /path not found/);
});

test("diagnose: reads a real directory, sorts findings worst-first, returns a score", () => {
  const home = mkdtempSync(join(tmpdir(), "chime-doc-"));
  try {
    const dir = join(home, "Developer", "demo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), "{}"); // manifest but no lockfile, no README, no .gitignore
    const ctx = gitCtx(home, { "rev-parse": { status: 128, stdout: "", stderr: "not a repo" } });
    const r = diagnose(base, ctx);
    assert.equal(r.ok, true);
    assert.equal(r.toolchain, "Node / JavaScript");
    assert.ok(typeof r.score === "number" && (r.score as number) < 100, "score reflects issues");
    const findings = r.findings as Finding[];
    assert.equal(findings[0]!.severity, "fail", "worst finding (not a repo) is first");
    assert.ok((r.nextSteps as string[]).length > 0, "actionable next steps returned");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("probe: a root CI marker (.gitlab-ci.yml) satisfies the CI probe", () => {
  const ctx = gitCtx("/home", { "rev-parse": { status: 128, stdout: "", stderr: "x" } });
  const ci = probe(base, ctx, new Set([".gitlab-ci.yml"]), "/home/Developer/demo").find((f) => f.id === "ci")!;
  assert.equal(ci.severity, "ok");
});

test("probe: no CI config anywhere warns with an actionable fix", () => {
  const ctx = gitCtx("/home", { "rev-parse": { status: 128, stdout: "", stderr: "x" } });
  const ci = probe(base, ctx, new Set(["package.json"]), "/home/Developer/demo").find((f) => f.id === "ci")!;
  assert.equal(ci.severity, "warn");
  assert.match(ci.fix ?? "", /\.github\/workflows/);
});

test("probe: a .github/ with real workflows is CI-present; templates-only is not (nested, read-only)", () => {
  const home = mkdtempSync(join(tmpdir(), "chime-ci-"));
  try {
    const ctx = gitCtx(home, { "rev-parse": { status: 128, stdout: "", stderr: "x" } });
    // .github exists but holds only an issue template -> still "no CI"
    mkdirSync(join(home, "tmpl", ".github", "ISSUE_TEMPLATE"), { recursive: true });
    writeFileSync(join(home, "tmpl", ".github", "ISSUE_TEMPLATE", "bug.md"), "x");
    let ci = probe(base, ctx, new Set([".github"]), join(home, "tmpl")).find((f) => f.id === "ci")!;
    assert.equal(ci.severity, "warn", ".github without workflows is not CI");
    // a real workflow file under .github/workflows/ -> CI present
    mkdirSync(join(home, "real", ".github", "workflows"), { recursive: true });
    writeFileSync(join(home, "real", ".github", "workflows", "ci.yml"), "name: ci");
    ci = probe(base, ctx, new Set([".github"]), join(home, "real")).find((f) => f.id === "ci")!;
    assert.equal(ci.severity, "ok", "a workflow file means CI is configured");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// --- handler / registry -----------------------------------------------------

test("handler: unknown project fails closed", () => {
  const ctx = gitCtx("/home", {});
  const r = projectDoctor.handler({ name: "nope" }, ctx) as { ok: boolean };
  assert.equal(r.ok, false);
});

test("handler: 'all' with an empty registry returns an empty board", () => {
  const ctx = gitCtx("/home", {});
  const r = projectDoctor.handler({ name: "all" }, ctx) as { ok: boolean; projects: unknown[] };
  assert.equal(r.ok, true);
  assert.deepEqual(r.projects, []);
});

test("registry: the capability is well-formed", () => {
  assert.equal(projectDoctor.name, "project_doctor");
  assert.equal(projectDoctor.inputSchema.required?.[0], "name");
});
