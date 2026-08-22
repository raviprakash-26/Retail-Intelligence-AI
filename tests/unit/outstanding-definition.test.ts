import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * What a document still owes is asked in one place.
 *
 * Nine things need this figure: the ageing report, the receipt and payment
 * forms, the guard that caps an allocation, the reminder a shop sends, the cash
 * projection, the income tax working paper, both document lists, the auditor's
 * long-overdue check, and the voucher page. Every one is answering the same
 * question about the same invoice, and a shop shown two answers has no way to
 * know which to believe.
 *
 * They did not always agree. "Total less what was receipted" is the definition
 * of settled from before returns existed, and it survived in one consumer after
 * another long after a credit note became another way an invoice gets settled —
 * found in the ageing, then in both list headlines, then in the auditor's
 * overdue check, then on the voucher page. Each was found by reading, and each
 * time there was one more.
 *
 * `settledByNotes` is the shared answer, and it reads the movement the return
 * posted to the control account rather than the return's own total — which is
 * what tells a return credited to a customer's account apart from one refunded
 * over the counter, a distinction no column on the document records.
 *
 * So this is a tripwire rather than another fix. Subtracting a paid figure from
 * a total is how every one of those consumers went wrong, and a tenth should
 * fail here rather than ship.
 */

/** Where the definition lives. It works the figure out; nothing else may. */
const DEFINITION = "src/server/settlements/outstanding.ts";

/**
 * The shapes the previous defects were actually written in.
 *
 * Taken from the four of them rather than imagined, because the forms differ
 * more than the mistake does: one used `.minus`, one raw SQL, one client-side
 * `Number` arithmetic, and one a plain subtraction. A detector that only knew
 * the last of those would have caught one in four.
 */
const PATTERNS: ReadonlyArray<{ what: string; find: () => RegExp }> = [
  {
    what: "subtract(total…, paid…)",
    find: () =>
      /subtract\(\s*[^,()]*total[A-Za-z]*[^,()]*,\s*[^,()]*paid[A-Za-z]*[^,()]*\)/gi,
  },
  {
    what: "total….minus(paid…)",
    find: () => /total[A-Za-z]*[^;]{0,80}?\.minus\([^;]{0,80}?paid[A-Za-z]*/gi,
  },
  {
    what: "Number(total…) - Number(paid…)",
    find: () => /Number\([^)]*total[^)]*\)\s*-\s*Number\([^)]*paid[^)]*\)/gi,
  },
  {
    what: 'SQL "totalAmount" - "paidAmount"',
    find: () => /"total[A-Za-z]*"\s*[-<>]\s*[a-z]?\."?paid[A-Za-z]*"?/gi,
  },
];

/** How each of those reads when somebody writes the tenth one. */
const HISTORICAL = [
  "subtract(sale.totalAmount, sale.paidAmount)",
  "money(outstanding._sum.totalAmount ?? 0).minus(money(outstanding._sum.paidAmount ?? 0))",
  "const open = Number(row.totalAmount) - Number(row.paidAmount);",
  'SUM(s."totalAmount" - s."paidAmount") AS outstanding',
  'AND s."totalAmount" > s."paidAmount"',
];

function sourceFiles(): string[] {
  return globSync("src/**/*.{ts,tsx}", { cwd: process.cwd() }).filter(
    (file) => !file.includes(".test."),
  );
}

describe("what a document still owes", () => {
  it("catches the ways this has been got wrong before", () => {
    // The tripwire's own test. Without it, a pattern that matched nothing
    // would make the case below pass by finding nothing anywhere — which is
    // the same green a correct codebase gives, and worth telling apart.
    const uncaught = HISTORICAL.filter(
      (line) => !PATTERNS.some(({ find }) => find().test(line)),
    );

    expect(
      uncaught,
      `the detector would not notice these:\n${uncaught.join("\n")}`,
    ).toEqual([]);
  });

  it("does not fire on the definition itself, or on ordinary bookkeeping", () => {
    // Two things that look adjacent and are not. `outstanding.ts` subtracts a
    // *settled* figure, having added the notes into it first, and the
    // allocation bookkeeping takes an allocation off `paidAmount` — neither is
    // a total less a paid column.
    const fine = [
      "const settled = add(sale.paidAmount, credited.get(sale.id) ?? money(0));",
      "subtract(sale.totalAmount, settled)",
      "paidAmount: toStorageString(subtract(sale.paidAmount, allocation.amount)),",
    ];

    for (const line of fine) {
      const tripped = PATTERNS.filter(({ find }) => find().test(line));
      expect(
        tripped.map((pattern) => pattern.what),
        `this is correct and should not trip the tripwire: ${line}`,
      ).toEqual([]);
    }
  });

  it("is worked out where the definition lives, and nowhere else", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      if (file.replace(/\\/g, "/") === DEFINITION) continue;
      const text = readFileSync(file, "utf8");

      for (const { what, find } of PATTERNS) {
        for (const match of text.matchAll(find())) {
          const line = text.slice(0, match.index).split("\n").length;
          offenders.push(`${file}:${line} — ${what} — ${match[0].trim()}`);
        }
      }
    }

    expect(
      offenders,
      `these work out what a document owes rather than asking for it:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("is asked for by the consumers that need it", () => {
    // Named rather than counted: a count is satisfied by deleting a consumer,
    // and each of these is a place somebody reads a number and acts on it.
    const consumers = [
      "src/server/settlements/settlement-service.ts",
      "src/server/settlements/payment-reminder.ts",
      "src/server/sales/sale-service.ts",
      "src/server/purchases/purchase-service.ts",
      "src/server/auditor/checks.ts",
      "src/server/forecast/cash-projection.ts",
      "src/server/tax/income-tax-service.ts",
    ];

    const missing = consumers.filter((file) => {
      const text = readFileSync(file, "utf8");
      return (
        !text.includes("settledByNotes") &&
        !text.includes("openInvoices") &&
        !text.includes("openBills")
      );
    });

    expect(
      missing,
      `these need what a document owes and no longer ask for it: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("still has a definition to point at", () => {
    const definition = readFileSync(DEFINITION, "utf8");
    expect(definition).toContain("export async function settledByNotes");
  });
});
