import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The project registry: Chime's knowledge of the user's repos. The SHAPE lives in
// code; the DATA lives OUTSIDE the repo at ~/.chime/projects.json, so a public
// clone carries no private project facts. Ship projects.example.json as a template.
// A row holds only STABLE facts; volatile facts (live version, git state) are read
// at call time by project_status, so a row never goes stale.

export type VersionKind = "json" | "cargo" | "changelog";

export interface Project {
  name: string;
  path: string; // relative to home, e.g. "Developer/example-web"
  kind: string;
  summary: string; // one plain line
  mantra?: string; // the project's four-beat discipline line
  remotes: string[]; // git anchors (display only)
  deployedUrl?: string; // health URL, only for deployed projects
  versionFile?: string; // relative to path, e.g. "package.json" | "core/Cargo.toml"
  versionKind?: VersionKind; // how to read versionFile
  checkDir?: string; // relative to path: where `check`/`doctor` run (default: path)
  check?: string[]; // fast NON-MUTATING gate as argv (never a build or --write)
  fullGate?: string; // the heavy gate, shown as a next-step string, never run
  doctor?: string[]; // read-only health command as argv, if any
}

// A generic, non-private template — also written to projects.example.json. It is
// NOT loaded at runtime; it only shows the shape.
export const EXAMPLE_PROJECTS: Project[] = [
  {
    name: "example-web",
    path: "Developer/example-web",
    kind: "Next.js app",
    summary: "An example web app — replace with your own.",
    mantra: "ask simple -> run simple -> verify simple -> resume simple",
    remotes: ["github.com/you/example-web"],
    deployedUrl: "https://example.com/health",
    versionFile: "package.json",
    versionKind: "json",
    check: ["pnpm", "lint"],
    fullGate: "pnpm lint && pnpm test && pnpm build",
  },
  {
    name: "example-cli",
    path: "Developer/example-cli",
    kind: "TypeScript CLI",
    summary: "An example CLI — replace with your own.",
    remotes: ["local"],
    versionFile: "package.json",
    versionKind: "json",
    check: ["npm", "run", "check"],
    fullGate: "npm run check && npm test",
  },
];

const VERSION_KINDS: readonly string[] = ["json", "cargo", "changelog"];

// Keep only well-formed rows; coerce/skip junk so a hand-edited file can't crash
// the secretary. A row needs at least name/path/kind/summary.
function coerce(row: unknown): Project | undefined {
  if (typeof row !== "object" || row === null) return undefined;
  const r = row as Record<string, unknown>;
  if (typeof r.name !== "string" || !r.name) return undefined;
  if (typeof r.path !== "string" || !r.path) return undefined;
  if (typeof r.kind !== "string" || typeof r.summary !== "string") return undefined;
  const p: Project = {
    name: r.name,
    path: r.path,
    kind: r.kind,
    summary: r.summary,
    remotes: Array.isArray(r.remotes) ? r.remotes.filter((x): x is string => typeof x === "string") : [],
  };
  if (typeof r.mantra === "string") p.mantra = r.mantra;
  if (typeof r.deployedUrl === "string") p.deployedUrl = r.deployedUrl;
  if (typeof r.versionFile === "string") p.versionFile = r.versionFile;
  if (typeof r.versionKind === "string" && VERSION_KINDS.includes(r.versionKind)) {
    p.versionKind = r.versionKind as VersionKind;
  }
  if (typeof r.checkDir === "string") p.checkDir = r.checkDir;
  if (Array.isArray(r.check)) p.check = r.check.filter((x): x is string => typeof x === "string");
  if (typeof r.fullGate === "string") p.fullGate = r.fullGate;
  if (Array.isArray(r.doctor)) p.doctor = r.doctor.filter((x): x is string => typeof x === "string");
  return p;
}

export function registryPath(home: string): string {
  return join(home, ".chime", "projects.json");
}

// Load the user's private registry from ~/.chime/projects.json. Missing or junk
// file → empty registry (the cli prints a hint). Never throws.
export function loadProjects(home: string): Project[] {
  const file = registryPath(home);
  if (!existsSync(file)) return [];
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(data)) return [];
    return data.map(coerce).filter((p): p is Project => p !== undefined);
  } catch {
    return [];
  }
}

export function findProject(name: string, reg: Project[]): Project | undefined {
  return reg.find((p) => p.name === name);
}

// Absolute path to the repo root.
export function projectPath(p: Project, home: string): string {
  return join(home, p.path);
}

// Absolute path where `check`/`doctor` run — the repo root, or a subdir when the
// buildable package lives below the git root (e.g. a monorepo plugin).
export function checkPath(p: Project, home: string): string {
  const root = projectPath(p, home);
  return p.checkDir ? join(root, p.checkDir) : root;
}

// Pure version reader: given the file kind and its text, pull the version string.
// Fails soft (returns undefined) on junk — a status read must never throw.
export function parseVersion(kind: VersionKind, text: string): string | undefined {
  if (kind === "json") {
    try {
      const v = (JSON.parse(text) as { version?: unknown }).version;
      return typeof v === "string" ? v : undefined;
    } catch {
      return undefined;
    }
  }
  if (kind === "cargo") {
    const m = text.match(/^version\s*=\s*"([^"]+)"/m);
    return m ? m[1] : undefined;
  }
  // changelog: the first version header. Handles "## 0.1.97", "## [0.0.2] - date",
  // and "## [v0.0.2]"; the digit-first rule skips "## [Unreleased]" and "### Added".
  const m = text.match(/^##[ \t]+\[?v?([0-9][^\]\s]*)/m);
  return m ? m[1] : undefined;
}
