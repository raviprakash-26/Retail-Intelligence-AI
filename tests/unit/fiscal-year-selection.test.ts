import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The year in the header is the year on the page.
 *
 * The selector sits in the application shell, on every screen, and setting it
 * writes a cookie. Reading that cookie was left to each page, and four read it
 * while the rest did not — so the financial statements, the entire report
 * catalogue and the tax working paper quietly used whichever year was *current*
 * instead. The header said 2025-26 and the statements under it were this
 * year's: a wrong figure presented as the right one, which is worse than an
 * error.
 *
 * Nothing could see it while a tenant had only ever been given one fiscal year.
 * The only id the cookie could hold was also the current one, so honouring it
 * and ignoring it gave the same answer. Making the calendar roll over is what
 * made the two differ.
 *
 * This reads the sources rather than rendering them. It cannot prove a page
 * scopes its query correctly; it fails the day somebody resolves a year without
 * asking which one the person is looking at, which is the mistake that actually
 * happened.
 */

const ROOT = process.cwd();

/** Everything under the signed-in application, plus the actions it calls. */
function sources(): string[] {
  return [
    ...globSync("src/app/(app)/**/*.tsx", { cwd: ROOT }),
    ...globSync("src/server/**/actions.ts", { cwd: ROOT }),
  ];
}

/**
 * Places that resolve a year from something other than the header, and why.
 *
 * Empty is not the goal — the goal is that each one is argued for in writing.
 * An omission and a decision look identical in a codebase, and only one of them
 * should pass.
 */
const RESOLVES_ITS_OWN: Readonly<Record<string, string>> = {};

describe("the fiscal year a page works in", () => {
  it("has pages to check, so this is not passing vacuously", () => {
    const users = sources().filter((file) =>
      readFileSync(file, "utf8").includes("selectedFiscalYear"),
    );
    expect(users.length).toBeGreaterThan(5);
  });

  for (const file of sources()) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("resolveFiscalYear")) continue;

    it(`${file} asks which year the person is looking at`, () => {
      expect(
        RESOLVES_ITS_OWN[file],
        `${file} calls resolveFiscalYear directly, so the header's year does ` +
          `not reach it. Use selectedFiscalYear, or add the file to ` +
          `RESOLVES_ITS_OWN with the reason it cannot.`,
      ).toBeTruthy();
    });
  }

  /**
   * The cookie is read in one place.
   *
   * Four pages used to read it themselves, which is how the rest came to be
   * written without it — there was no single thing to reach for.
   */
  it("is read from the cookie in exactly one module", () => {
    const readers = [...globSync("src/**/*.{ts,tsx}", { cwd: ROOT })].filter(
      (file) => {
        const source = readFileSync(file, "utf8");
        return (
          source.includes("FISCAL_YEAR_COOKIE") &&
          !file.endsWith("lib/constants/cookies.ts")
        );
      },
    );

    expect(readers.sort()).toEqual(
      [
        // Writes it, when somebody picks a year.
        "src/server/search/actions.ts",
        // Reads it, for everything else.
        "src/server/fiscal/fiscal-service.ts",
      ].sort(),
    );
  });
});
