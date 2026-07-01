import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Capability, HandlerContext, JsonSchema, ToolResultPayload } from "../types.ts";
import { findProject, loadProjects } from "../projects.ts";

// Chime's per-project memory — how it "grows with" the user. One markdown notebook
// per project under ~/.chime/memory, mirroring the repos' own PROJECT_MEMORY.md
// shape. This is Chime's OWN data (not the user's project repos), so writing here
// does not break the strictly-read-only stance on their code.

export const SECTIONS = ["Verified Facts", "Failed Attempts", "Last Session", "Next Run"] as const;
export type Section = (typeof SECTIONS)[number];

function notebookPath(home: string, name: string): string {
  return join(home, ".chime", "memory", `${name}.md`);
}

function template(name: string): string {
  return `# ${name} — Chime notebook\n\n${SECTIONS.map((s) => `## ${s}\n`).join("\n")}`;
}

// Pure: append a bullet at the end of `section`'s block. Returns null if the
// section header is absent, so a bad section never silently loses the note.
export function addBullet(content: string, section: string, text: string): string | null {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${section}`);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith("## ")) {
      end = i;
      break;
    }
  }
  let insertAt = end;
  while (insertAt - 1 > start && lines[insertAt - 1]!.trim() === "") insertAt--;
  lines.splice(insertAt, 0, `- ${text}`);
  return lines.join("\n");
}

const inputSchema: JsonSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["read", "note"],
      description: "read = show a project's notebook; note = append one fact to a section",
    },
    name: { type: "string", description: "the project name (must be a registered project)" },
    section: {
      type: "string",
      enum: [...SECTIONS],
      description: "note only: which section to append to",
    },
    text: { type: "string", description: "note only: the fact to remember (one line)" },
  },
  required: ["action", "name"],
  additionalProperties: false,
};

function handler(input: Record<string, unknown>, ctx: HandlerContext): ToolResultPayload {
  const action = String(input.action ?? "");
  const name = String(input.name ?? "");

  if (!findProject(name, loadProjects(ctx.home))) return { ok: false, action, error: `unknown project: ${name}` };
  const file = notebookPath(ctx.home, name);

  if (action === "read") {
    if (!existsSync(file)) return { ok: true, action, name, empty: true, content: "" };
    try {
      return { ok: true, action, name, content: readFileSync(file, "utf8") };
    } catch (e) {
      return { ok: false, action, name, error: `cannot read notebook: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  if (action === "note") {
    const section = String(input.section ?? "");
    const text = String(input.text ?? "").trim();
    if (!(SECTIONS as readonly string[]).includes(section)) {
      return { ok: false, action, name, error: `unknown section: ${section} (expected one of ${SECTIONS.join(", ")})` };
    }
    if (!text) return { ok: false, action, name, error: "note text is empty" };

    const current = existsSync(file) ? readFileSync(file, "utf8") : template(name);
    const next = addBullet(current, section, text);
    if (next === null) return { ok: false, action, name, error: `section not found: ${section}` };
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, next, "utf8");
    } catch (e) {
      return { ok: false, action, name, error: `cannot write notebook: ${e instanceof Error ? e.message : String(e)}` };
    }
    return { ok: true, action, name, section, saved: text, path: file };
  }

  return { ok: false, action, name, error: `unknown action: ${action} (expected read|note)` };
}

export const memory: Capability = {
  name: "memory",
  description:
    "Keep and recall notes about a project across sessions, so Chime grows with the user's work. Notebooks live under ~/.chime/memory with four sections: Verified Facts, Failed Attempts, Last Session, Next Run. action=read shows a project's notebook; action=note appends one fact to a section. Call note when the user shares a durable fact about a project, or at the end of work to record what was done (Last Session) and what is next (Next Run). Call read before starting on a project to recall its state.",
  inputSchema,
  handler,
};
