import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A date the product chose has to reach the person it was chosen for.
 *
 * When the start of the financial year falls in a closed month, an opening
 * balance is dated forward to the earliest month still open. That is the right
 * behaviour and it is covered by `opening-balance-dating.test.ts` — but the
 * first version of it shipped with the telling half missing. The service set a
 * `deferred` flag, wrote a doc comment promising "the caller is told the date
 * moved rather than finding out later", and then nothing read the flag. The
 * commit message said so too. Every test passed, because the tests asked where
 * the entry landed and never asked whether anyone was told.
 *
 * A value computed and dropped is the same defect as a value computed wrong,
 * and it is harder to see. So this walks the whole chain — service, action,
 * screen — and fails if any link stops carrying it.
 *
 * It reads source rather than rendering, deliberately: the failure mode is a
 * link being deleted, and a test that mounts the dialog would still pass with
 * the toast removed as long as the form submitted.
 */

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const FIELD = "openingDeferredTo";

/** The two services that can write an opening balance on a master record. */
const SERVICES = [
  "src/server/master-data/party-service.ts",
  "src/server/master-data/product-service.ts",
];

/** The screens that create those records. */
const SCREENS = [
  "src/components/master-data/party-manager.tsx",
  "src/components/master-data/product-manager.tsx",
];

const ACTIONS = "src/server/master-data/actions.ts";
const ANNOUNCER = "src/components/master-data/opening-balance-fields.tsx";

describe("the deferred opening date", () => {
  it("is returned by every service that can defer one", () => {
    for (const path of SERVICES) {
      const source = read(path);

      // Guards against the tripwire quietly going vacuous: if deferring is ever
      // removed from a service, this says so rather than passing on absence.
      expect(
        source.includes("deferred"),
        `${path} no longer defers an opening balance. If that is deliberate, ` +
          `this test and the announcement it protects should go with it.`,
      ).toBe(true);

      expect(
        source.includes(FIELD),
        `${path} defers an opening balance without returning ${FIELD}, so the ` +
          `date it chose cannot reach the screen.`,
      ).toBe(true);
    }
  });

  it("survives the server action's result type", () => {
    // The actions are the boundary the screen sees. A result type narrowed back
    // to `{ id, code }` would drop the field with nothing else failing.
    const source = read(ACTIONS);
    const occurrences = [...source.matchAll(new RegExp(FIELD, "g"))].length;

    expect(
      occurrences,
      `${ACTIONS} should expose ${FIELD} on both the party and product create ` +
        `results; found ${occurrences} mention(s).`,
    ).toBeGreaterThanOrEqual(2);
  });

  it("is read by both screens and handed to the announcement", () => {
    for (const path of SCREENS) {
      const source = read(path);

      expect(
        source.includes(`announceDeferredOpening(result.data.${FIELD}`),
        `${path} does not pass ${FIELD} to announceDeferredOpening, so a shop ` +
          `adding a record with an opening balance is never told the date the ` +
          `books used.`,
      ).toBe(true);
    }
  });

  it("ends in something the shop can actually see", () => {
    // The link that was missing. A helper that takes the date and returns
    // without showing it would satisfy every check above.
    const source = read(ANNOUNCER);
    const body = source.slice(
      source.indexOf("export function announceDeferredOpening"),
    );

    expect(
      /toast\.\w+\(/.test(body),
      `announceDeferredOpening no longer raises a toast, so the deferred date ` +
        `is computed, threaded through two layers, and then discarded.`,
    ).toBe(true);

    expect(
      /closed month/i.test(body),
      `The announcement should say why the date moved, not only what it is. ` +
        `A date with no reason reads as a bug to the person seeing it.`,
    ).toBe(true);
  });
});
