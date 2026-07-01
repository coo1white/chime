import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projects } from "../src/tools/projects.ts";
import { registryPath, type Project } from "../src/projects.ts";
import type { HandlerContext } from "../src/types.ts";

const FIXTURE: Project[] = [
  { name: "demo-web", path: "Developer/demo-web", kind: "Next.js app", summary: "demo web", mantra: "ask simple -> run simple", remotes: ["local"], versionFile: "package.json", versionKind: "json", check: ["pnpm", "lint"] },
  { name: "demo-cli", path: "Developer/demo-cli", kind: "TS CLI", summary: "demo cli", remotes: ["local"], versionFile: "Cargo.toml", versionKind: "cargo" },
];

function ctxWith(reg: Project[] | null): HandlerContext {
  const home = mkdtempSync(join(tmpdir(), "chime-projtool-"));
  if (reg) {
    mkdirSync(join(home, ".chime"), { recursive: true });
    writeFileSync(registryPath(home), JSON.stringify(reg));
  }
  return {
    runCommand: () => {
      throw new Error("projects tool must not shell out");
    },
    env: {},
    now: () => new Date(0),
    home,
  };
}

test("action=list returns every registered project", async () => {
  const r = await projects.handler({ action: "list" }, ctxWith(FIXTURE));
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
  const names = (r.projects as { name: string }[]).map((p) => p.name);
  assert.deepEqual(names.sort(), ["demo-cli", "demo-web"]);
});

test("an empty registry lists nothing but points at the example file", async () => {
  const r = await projects.handler({ action: "list" }, ctxWith(null));
  assert.equal(r.ok, true);
  assert.equal(r.count, 0);
  assert.match(String(r.note), /projects\.example\.json/);
});

test("list rows carry the mantra when present", async () => {
  const r = await projects.handler({ action: "list" }, ctxWith(FIXTURE));
  const web = (r.projects as { name: string; mantra?: string }[]).find((p) => p.name === "demo-web");
  assert.match(web?.mantra ?? "", /ask simple/);
});

test("action=brief returns the full card for a known project", async () => {
  const r = await projects.handler({ action: "brief", name: "demo-cli" }, ctxWith(FIXTURE));
  assert.equal(r.ok, true);
  assert.equal(r.name, "demo-cli");
  assert.ok(String(r.versionSource).includes("Cargo.toml"));
});

test("action=brief on an unknown project fails closed", async () => {
  const r = await projects.handler({ action: "brief", name: "nope" }, ctxWith(FIXTURE));
  assert.equal(r.ok, false);
  assert.match(String(r.error), /unknown project/);
});

test("brief with no name fails closed", async () => {
  const r = await projects.handler({ action: "brief" }, ctxWith(FIXTURE));
  assert.equal(r.ok, false);
});

test("an unknown action fails closed", async () => {
  const r = await projects.handler({ action: "wat" }, ctxWith(FIXTURE));
  assert.equal(r.ok, false);
});
