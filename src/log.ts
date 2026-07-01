// Diagnostics go to stderr; stdout stays reserved for assistant-facing output.
function write(level: string, msg: string): void {
  process.stderr.write(`[chime:${level}] ${msg}\n`);
}

export const log = {
  info: (m: string) => write("info", m),
  warn: (m: string) => write("warn", m),
  error: (m: string) => write("error", m),
};
