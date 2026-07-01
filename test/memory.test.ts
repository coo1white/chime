import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memory, addBullet } from "../src/tools/memory.ts";
import { registryPath } from "../src/projects.ts";
import type { HandlerContext } from "../src/types.ts";

function ctx(home: string): HandlerContext {
  return {
    runCommand: () => {
      throw new Error("memory tool must not shell out");
    },
    env: {},
    now: () => new Date(0),
    home,
  };
}

// A home whose registry knows one project, "demo-web".
function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "chime-mem-"));
  mkdirSync(join(home, ".chime"), { recursive: true });
  writeFileSync(
    registryPath(home),
    JSON.stringify([{ name: "demo-web", path: "Developer/demo-web", kind: "app", summary: "y", remotes: [] }]),
  );
  return home;
}

test("addBullet inserts under the right section, leaving others alone", () => {
  const base = "# x\n\n## Verified Facts\n\n## Next Run\n";
  const out = addBullet(base, "Verified Facts", "the db is sqlite")!;
  assert.match(out, /## Verified Facts\n- the db is sqlite/);
  // a second note stacks under the same section
  const out2 = addBullet(out, "Verified Facts", "port is 8787")!;
  const vf = out2.split("## Next Run")[0];
  assert.match(vf, /- the db is sqlite/);
  assert.match(vf, /- port is 8787/);
});

test("addBullet returns null for an unknown section", () => {
  assert.equal(addBullet("## Verified Facts\n", "Nope", "x"), null);
});

test("note creates the notebook with the template and the bullet", async () => {
  const home = tempHome();
  const r = await memory.handler({ action: "note", name: "demo-web", section: "Verified Facts", text: "zero deps" }, ctx(home));
  assert.equal(r.ok, true);
  const file = join(home, ".chime", "memory", "demo-web.md");
  assert.ok(existsSync(file));
  const text = readFileSync(file, "utf8");
  assert.match(text, /# demo-web — Chime notebook/);
  assert.match(text, /## Verified Facts\n- zero deps/);
  assert.match(text, /## Next Run/); // template sections all present
});

test("read returns the notebook content", async () => {
  const home = tempHome();
  await memory.handler({ action: "note", name: "demo-web", section: "Next Run", text: "wire the router" }, ctx(home));
  const r = await memory.handler({ action: "read", name: "demo-web" }, ctx(home));
  assert.equal(r.ok, true);
  assert.match(String(r.content), /wire the router/);
});

test("read on an untouched project is empty, not an error", async () => {
  const r = await memory.handler({ action: "read", name: "demo-web" }, ctx(tempHome()));
  assert.equal(r.ok, true);
  assert.equal(r.empty, true);
});

test("unknown project fails closed", async () => {
  const r = await memory.handler({ action: "note", name: "nope", section: "Verified Facts", text: "x" }, ctx(tempHome()));
  assert.equal(r.ok, false);
});

test("unknown section fails closed", async () => {
  const r = await memory.handler({ action: "note", name: "demo-web", section: "Wat", text: "x" }, ctx(tempHome()));
  assert.equal(r.ok, false);
});

test("note with empty text fails closed", async () => {
  const r = await memory.handler({ action: "note", name: "demo-web", section: "Verified Facts", text: "  " }, ctx(tempHome()));
  assert.equal(r.ok, false);
});
