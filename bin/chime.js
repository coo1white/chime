#!/usr/bin/env node
// Thin launcher → compiled entry.
import("../dist/cli.js").catch((err) => {
  process.stderr.write(`chime: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
