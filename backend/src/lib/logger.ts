// Structured JSON logging. Deliberately dependency-free: one line per event,
// safe fields only. Callers must never pass passwords, tokens, raw QR secrets,
// or unnecessary PII. If richer production logging is later required, this
// module can be swapped for pino without touching call sites.
type Level = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVELS[(process.env.LOG_LEVEL as Level) ?? (process.env.NODE_ENV === "test" ? "error" : "info")] ?? LEVELS.info;

function emit(level: Level, event: string, fields: LogFields = {}): void {
  if (LEVELS[level] < MIN_LEVEL) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (event: string, fields?: LogFields) => emit("debug", event, fields),
  info: (event: string, fields?: LogFields) => emit("info", event, fields),
  warn: (event: string, fields?: LogFields) => emit("warn", event, fields),
  error: (event: string, fields?: LogFields) => emit("error", event, fields),
};
