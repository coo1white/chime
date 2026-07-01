import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toAnthropicTools,
  findCapability,
  BUILTIN_CAPABILITIES,
} from "../src/registry.ts";
import type { Capability } from "../src/types.ts";

const sample: Capability[] = [
  {
    name: "echo",
    description: "Echo the message back.",
    inputSchema: {
      type: "object",
      properties: { msg: { type: "string" } },
      required: ["msg"],
    },
    handler: (input) => ({ ok: true, msg: input.msg }),
  },
  {
    name: "ping",
    description: "Return pong.",
    inputSchema: { type: "object", properties: {} },
    handler: () => ({ ok: true, pong: true }),
  },
];

test("toAnthropicTools maps each capability to {name, description, input_schema}", () => {
  const tools = toAnthropicTools(sample);
  assert.equal(tools.length, 2);
  assert.deepEqual(tools[0], {
    name: "echo",
    description: "Echo the message back.",
    input_schema: sample[0]!.inputSchema,
  });
  // input_schema is the verbatim inputSchema object (single source of truth)
  assert.equal(tools[0]!.input_schema, sample[0]!.inputSchema);
  assert.equal(tools[1]!.input_schema.type, "object");
});

test("findCapability looks up by name; misses return undefined", () => {
  assert.equal(findCapability("echo", sample)?.name, "echo");
  assert.equal(findCapability("ping", sample)?.name, "ping");
  assert.equal(findCapability("nope", sample), undefined);
});

test("BUILTIN_CAPABILITIES: unique snake_case names, object schemas", () => {
  const names = BUILTIN_CAPABILITIES.map((c) => c.name);
  assert.equal(new Set(names).size, names.length, "names must be unique");
  assert.ok(names.includes("disk_maintenance"));
  for (const n of names) {
    assert.match(n, /^[a-z][a-z0-9_]*$/, `not snake_case: ${n}`);
  }
  for (const c of BUILTIN_CAPABILITIES) {
    assert.equal(c.inputSchema.type, "object", `${c.name} schema must be object`);
  }
});
