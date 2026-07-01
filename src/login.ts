import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { writeChimeConfig } from "./config.ts";

// `chime login`: run the Google browser popup (gcloud Application Default
// Credentials), then save the Vertex project + location to ~/.chime/config.json so
// later runs need no key and no env. After this, `chime` just works.

function run(cmd: string, args: string[], inherit = false): { ok: boolean; out: string; err: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: inherit ? "inherit" : "pipe" });
  return { ok: r.status === 0 && !r.error, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.error?.message ?? "").trim() };
}

function haveGcloud(): boolean {
  return run("gcloud", ["--version"]).ok;
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

  process.stdout.write("chime login: opening the Google sign-in in your browser...\n");
  // Interactive: opens the browser popup and stores Application Default Credentials.
  const login = run("gcloud", ["auth", "application-default", "login"], true);
  if (!login.ok) {
    process.stderr.write("chime login: gcloud auth did not finish. Nothing was saved.\n");
    return 1;
  }

  // Resolve the project: env wins, else the active gcloud project.
  let project = env.CHIME_VERTEX_PROJECT || "";
  if (!project) {
    const p = run("gcloud", ["config", "get-value", "project"]);
    if (p.ok && p.out && p.out !== "(unset)") project = p.out;
  }
  if (!project) {
    process.stderr.write(
      "chime login: signed in, but no project is set. Set one and re-run:\n" +
        "  gcloud config set project YOUR_PROJECT   (or)   CHIME_VERTEX_PROJECT=YOUR_PROJECT chime login\n",
    );
    return 1;
  }
  const location = env.CHIME_VERTEX_LOCATION || "us-central1";

  writeChimeConfig(home, { backend: "vertex", project, location });
  process.stdout.write(
    `chime login: saved. backend=vertex project=${project} location=${location}\n` +
      "You can now just run `chime` — no key needed. (Make sure the Vertex AI API is enabled for the project.)\n",
  );
  return 0;
}
