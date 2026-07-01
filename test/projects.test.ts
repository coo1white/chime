import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadProjects,
  registryPath,
  findProject,
  projectPath,
  checkPath,
  parseVersion,
  EXAMPLE_PROJECTS,
  type Project,
} from "../src/projects.ts";

const FIXTURE: Project[] = [
  {
    name: "demo-web",
    path: "Developer/demo-web",
    kind: "Next.js app",
    summary: "demo web",
    mantra: "ask simple -> run simple -> verify simple -> resume simple",
    remotes: ["github.com/you/demo-web"],
    deployedUrl: "https://demo.example/health",
    versionFile: "package.json",
    versionKind: "json",
    check: ["pnpm", "lint"],
    fullGate: "pnpm lint && pnpm test",
  },
  {
    name: "demo-cli",
    path: "Developer/demo-cli",
    kind: "TS CLI",
    summary: "demo cli",
    remotes: ["local"],
    versionFile: "package.json",
    versionKind: "json",
    checkDir: "packages/cli",
    check: ["npm", "run", "check"],
  },
];

function homeWith(data: unknown): string {
  const home = mkdtempSync(join(tmpdir(), "chime-reg-"));
  const file = registryPath(home);
  mkdirSync(join(home, ".chime"), { recursive: true });
  writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
  return home;
}

test("loadProjects: missing file is an empty registry, not an error", () => {
  const home = mkdtempSync(join(tmpdir(), "chime-empty-"));
  assert.deepEqual(loadProjects(home), []);
});

test("loadProjects: reads and coerces a valid file", () => {
  const reg = loadProjects(homeWith(FIXTURE));
  assert.equal(reg.length, 2);
  assert.equal(reg[0]!.name, "demo-web");
  assert.equal(reg[1]!.checkDir, "packages/cli");
});

test("loadProjects: junk / non-array / bad rows fail soft", () => {
  assert.deepEqual(loadProjects(homeWith("not json")), []);
  assert.deepEqual(loadProjects(homeWith({ not: "an array" })), []);
  // a row missing name/path is dropped; a good row survives
  const reg = loadProjects(homeWith([{ kind: "x" }, FIXTURE[0]]));
  assert.equal(reg.length, 1);
  assert.equal(reg[0]!.name, "demo-web");
});

test("findProject looks up by name within a registry", () => {
  const reg = loadProjects(homeWith(FIXTURE));
  assert.equal(findProject("demo-cli", reg)?.kind, "TS CLI");
  assert.equal(findProject("nope", reg), undefined);
});

test("projectPath and checkPath resolve under home", () => {
  assert.equal(projectPath(FIXTURE[0]!, "/Users/x"), "/Users/x/Developer/demo-web");
  assert.equal(checkPath(FIXTURE[1]!, "/Users/x"), "/Users/x/Developer/demo-cli/packages/cli");
  assert.equal(checkPath(FIXTURE[0]!, "/Users/x"), projectPath(FIXTURE[0]!, "/Users/x"));
});

test("parseVersion reads json / cargo / changelog", () => {
  assert.equal(parseVersion("json", '{"name":"x","version":"1.2.3"}'), "1.2.3");
  assert.equal(parseVersion("cargo", 'name = "x"\nversion = "3.1.57"\n'), "3.1.57");
  const cl = "# Changelog\n\n## [Unreleased]\n- wip\n\n## [0.0.2] - 2026-06-15\n- done\n";
  assert.equal(parseVersion("changelog", cl), "0.0.2");
  assert.equal(parseVersion("changelog", "## 0.1.97\n- x\n"), "0.1.97");
  assert.equal(parseVersion("changelog", "## [Unreleased]\n\n## [v0.0.2] - 2026\n"), "0.0.2");
  assert.equal(parseVersion("changelog", "## [Unreleased]\n### Added\n- x\n"), undefined);
});

test("parseVersion fails soft on junk", () => {
  assert.equal(parseVersion("json", "not json"), undefined);
  assert.equal(parseVersion("cargo", "no version here"), undefined);
  assert.equal(parseVersion("changelog", "## [Unreleased]\nonly wip"), undefined);
});

test("the shipped example registry is well-formed", () => {
  assert.ok(EXAMPLE_PROJECTS.length >= 1);
  for (const p of EXAMPLE_PROJECTS) {
    assert.match(p.path, /^Developer\//);
    assert.ok(p.name && p.kind && p.summary);
  }
});
