import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Server code logs through the logger, not through the console.
 *
 * `lib/observability/logger` opens by naming the thing it exists to replace:
 *
 *   > `console.error("Sales action failed", error)` is readable by a person
 *   > watching a terminal and almost useless to anything else.
 *
 * That sentence was quoting a line that was still in the codebase. Three
 * modules had been moved across — Sales, Payroll, Returns — and nine had not,
 * in the same function, at the same position, with the same message. Half a
 * migration looks exactly like a finished one from inside any single file,
 * which is why it stayed that way.
 *
 * Two things are lost by a `console.error`, and the logger's own comment names
 * both. Context never goes through `redactValue`, and "a password reaching a
 * log aggregator is as leaked as one reaching the database". And there are no
 * fields — no module, no tenant — so the questions worth asking of an error
 * rate cannot be asked of it at all.
 *
 * A rule about a call that is easy to write and invisible once written is a
 * rule that needs a test rather than a convention.
 */

/**
 * Deliberate console output, with the reason.
 *
 * Named rather than pattern-matched, for the reason the authorization sweep
 * gives: an omission and a decision look identical in a codebase, and only one
 * of them should pass.
 */
const DELIBERATE: Record<string, string> = {
  "src/server/email/mailer.ts":
    "The console mail driver prints a formatted email to the terminal in development. Structured JSON would defeat the point of it.",
};

const CONSOLE_CALL = /\bconsole\s*\.\s*(log|info|warn|error|debug|trace)\s*\(/;

function offenders(): string[] {
  const found: string[] = [];
  for (const file of globSync("src/server/**/*.ts", { cwd: process.cwd() })) {
    if (file in DELIBERATE) continue;
    const source = readFileSync(file, "utf8");
    for (const [index, line] of source.split("\n").entries()) {
      // Skip the comment that describes the rule rather than breaking it.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      if (CONSOLE_CALL.test(line)) found.push(`${file}:${index + 1}`);
    }
  }
  return found;
}

describe("server logging", () => {
  it("has enough server files for this to mean anything", () => {
    // A glob that stops matching would make the check below vacuously true.
    const files = globSync("src/server/**/*.ts", { cwd: process.cwd() });
    expect(files.length).toBeGreaterThan(50);
  });

  it("never writes to the console outside the places named here", () => {
    expect(offenders()).toEqual([]);
  });

  it("keeps the exemption list honest", () => {
    // An exemption for a file that no longer writes to the console is a claim
    // nobody has checked in a while.
    const stale = Object.keys(DELIBERATE).filter((file) => {
      const source = readFileSync(file, "utf8");
      return !source
        .split("\n")
        .some(
          (line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && CONSOLE_CALL.test(line),
        );
    });

    expect(stale).toEqual([]);
  });
});
