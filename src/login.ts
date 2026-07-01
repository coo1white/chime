import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { writeChimeConfig } from "./config.ts";
import { tokenFrom, type GcloudRunner } from "./vertex.ts";

// `chime login`: get Chime onto Vertex AI with as little friction as possible.
// If a gcloud credential already works (ADC or a plain `gcloud auth login`), reuse
// it — no browser. Only sign in when there is no working token. Either way, save
// the project + location to ~/.chime/config.json so later runs need nothing.

const runner: GcloudRunner = (args) => {
  const r = spawnSync("gcloud", args, { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "" };
};

function haveGcloud(): boolean {
  return runner(["--version"]).status === 0;
}

function resolveProject(env: Record<string, string | undefined>): string {
  if (env.CHIME_VERTEX_PROJECT) return env.CHIME_VERTEX_PROJECT;
  const p = runner(["config", "get-value", "project"]);
  const out = p.stdout.trim();
  return p.status === 0 && out && out !== "(unset)" ? out : "";
}

function save(env: Record<string, string | undefined>, home: string): number {
  const project = resolveProject(env);
  if (!project) {
    process.stderr.write(
      "chime login: signed in, but no project is set. Set one and re-run:\n" +
        "  gcloud config set project YOUR_PROJECT   (or)   CHIME_VERTEX_PROJECT=... chime login\n",
    );
    return 1;
  }
  const location = env.CHIME_VERTEX_LOCATION || "us-central1";
  writeChimeConfig(home, { backend: "vertex", project, location });
  process.stdout.write(
    `chime login: ready. backend=vertex project=${project} location=${location}\n` +
      "Run `chime`. (Make sure the Vertex AI API is enabled: gcloud services enable aiplatform.googleapis.com)\n",
  );
  return 0;
}

export async function runLogin(
  env: Record<string, string | undefined> = process.env,
  home: string = env.HOME || homedir(),
): Promise<number> {
  if (!haveGcloud()) {
    process.stderr.write(
      "chime login: gcloud is not installed. Install the Google Cloud CLI first:\n" +
        "  https://cloud.google.com/sdk/docs/install\n",
    );
    return 1;
  }

  // Already have a working credential? Reuse it — no browser.
  if (tokenFrom(runner)) {
    process.stdout.write("chime login: found a working gcloud credential — no sign-in needed.\n");
    return save(env, home);
  }

  process.stdout.write("chime login: no credential yet — opening the Google sign-in...\n");
  spawnSync("gcloud", ["auth", "application-default", "login"], { stdio: "inherit" });

  if (!tokenFrom(runner)) {
    process.stderr.write(
      "chime login: still no working token — nothing saved.\n" +
        "  • On the consent page, check EVERY box (esp. \"...Google Cloud data\").\n" +
        "  • Or try the plain user login instead:  gcloud auth login\n" +
        "  • Workspace domains can block this scope; an admin may need to allow it,\n" +
        "    or use a personal Google account for the login.\n",
    );
    return 1;
  }
  return save(env, home);
}
