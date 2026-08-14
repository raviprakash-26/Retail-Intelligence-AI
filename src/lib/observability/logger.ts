import { redactValue, type JsonSafe } from "@/lib/redaction";

/**
 * Structured logging.
 *
 * `console.error("Sales action failed", error)` is readable by a person
 * watching a terminal and almost useless to anything else. Once the process is
 * a container behind a log driver, the only questions worth asking — how many
 * of these were there, which tenant, which module, is it getting worse — need
 * fields rather than prose, and a line that has to be parsed with a regular
 * expression is a line nobody queries.
 *
 * So each record is one JSON object on one line: level, message, timestamp, and
 * whatever context the caller attached. That is what every aggregator ingests
 * without configuration, and it survives the fact that this product has no
 * aggregator wired up — the output is still perfectly readable in `docker logs`.
 *
 * Two rules the logger enforces rather than trusting callers with:
 *
 * Context runs through the same redaction the audit log uses, because a
 * password reaching a log aggregator is as leaked as one reaching the database.
 *
 * An Error is unwrapped into name, message and stack instead of being
 * stringified, since `JSON.stringify(new Error("x"))` is `{}` — which is how
 * exceptions quietly become empty objects in logs.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogContext = Record<string, unknown>;

export type LogRecord = {
  level: LogLevel;
  message: string;
  time: string;
  [key: string]: JsonSafe | LogLevel | string;
};

/** Turns an Error into fields, since JSON.stringify flattens it to nothing. */
export function describeError(error: unknown): JsonSafe {
  if (error instanceof Error) {
    const described: Record<string, JsonSafe> = {
      name: error.name,
      message: error.message,
    };
    if (error.stack) described.stack = error.stack.split("\n").slice(0, 12);
    if (error.cause !== undefined) described.cause = describeError(error.cause);
    return described;
  }
  return redactValue(error);
}

/**
 * Builds the record without writing it.
 *
 * Separated from the writing so the shape can be tested without capturing
 * console output, which is the sort of test that passes for the wrong reason.
 */
export function buildRecord(
  level: LogLevel,
  message: string,
  context: LogContext = {},
  now: Date = new Date(),
): LogRecord {
  const record: LogRecord = {
    level,
    message,
    time: now.toISOString(),
  };

  // Redact the context as a whole rather than value by value.
  //
  // The rule matches on *key names*, so handing it each value on its own skips
  // the only check that matters — `redactValue("hunter2")` is just a string,
  // and the fact that it was called `password` is lost before the rule ever
  // sees it. Passing the object in keeps the keys attached to their values.
  const reserved = new Set(["level", "message", "time", "error"]);
  const safe = Object.fromEntries(
    Object.entries(context).filter(([key]) => !reserved.has(key)),
  );

  Object.assign(record, redactValue(safe) as Record<string, JsonSafe>);

  // The error is described rather than redacted: its own fields are a name, a
  // message and a stack, none of which the key rule would recognise.
  if ("error" in context) record.error = describeError(context.error);

  return record;
}

function configuredLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL;
  return (LOG_LEVELS as readonly string[]).includes(raw ?? "")
    ? (raw as LogLevel)
    : "info";
}

export function shouldLog(level: LogLevel, threshold: LogLevel): boolean {
  return SEVERITY[level] >= SEVERITY[threshold];
}

function write(level: LogLevel, message: string, context?: LogContext): void {
  if (!shouldLog(level, configuredLevel())) return;
  const line = JSON.stringify(buildRecord(level, message, context));
  // Warnings and errors to stderr, everything else to stdout: that is the
  // split every container runtime already knows how to route differently.
  if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const logger = {
  debug: (message: string, context?: LogContext) =>
    write("debug", message, context),
  info: (message: string, context?: LogContext) =>
    write("info", message, context),
  warn: (message: string, context?: LogContext) =>
    write("warn", message, context),
  error: (message: string, context?: LogContext) =>
    write("error", message, context),
};
