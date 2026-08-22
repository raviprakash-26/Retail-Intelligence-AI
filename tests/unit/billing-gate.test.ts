import { existsSync, readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * An action that can post to the ledger asks billing first.
 *
 * A lapsed subscription closes exactly one door. `guards.ts` says so: reading,
 * printing and exporting what is already there stay open, because those books
 * belong to the business rather than to the platform, and what is refused is
 * recording something new. It also says where the refusal has to live —
 *
 *   > All three are asked on the server, in the action that does the work. The
 *   > navigation marks locked items and the pages render an explanation, but
 *   > both are presentation. A control that is merely hidden is not a lock.
 *
 * Across the codebase that rule was kept with one shape: every action that can
 * reach `postJournalEntry` consults `billingRefusal`, and every action that
 * only edits master data does not. Sales, purchases, returns, receipts and
 * payments, expenses, payroll, stock adjustments, bank postings and the
 * importer all sit on the first side of that line.
 *
 * The accounting module did not. A shop whose subscription had lapsed could
 * not raise an invoice, and could open the journal and post the debits and
 * credits that invoice would have made — or close its year, which writes a
 * closing entry of its own. The lock was on the front door and the side door
 * was open, which is the exact failure the paragraph above was written about.
 *
 * So this is a tripwire rather than a list of the four that were missing. The
 * next module to post something will be caught here rather than shipped.
 */

/** The one funnel every posting goes through. */
const LEDGER = "postJournalEntry";

/** What an action calls to ask. */
const GATE = "billingRefusal";

/**
 * Deliberately outside the rule, with the reason.
 *
 * Registration posts a company's opening entries, so it reaches the ledger like
 * any other writer — but it is how a business becomes a subscriber in the first
 * place. Asking billing whether an account that does not exist yet may be
 * created would mean nobody could ever sign up.
 */
const EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    "src/server/auth/actions.ts",
    "registration creates the subscription it would otherwise be checked against",
  ],
]);

/**
 * The individual actions that must ask, named rather than counted.
 *
 * The file-level rule below catches a whole module that forgets. It cannot
 * catch one action inside a module that remembers, because a file with two
 * writers and one gate still contains the call — a gap found by removing a
 * single guard and watching the rule stay green.
 *
 * So the posting actions are named. A count would be satisfied by deleting one;
 * each of these is somewhere a shopkeeper puts a figure into the ledger.
 */
const MUST_ASK: ReadonlyArray<{ file: string; actions: readonly string[] }> = [
  {
    file: "src/server/accounting/journal-actions.ts",
    actions: ["createJournalEntryAction", "reverseJournalEntryAction"],
  },
  {
    file: "src/server/accounting/period-actions.ts",
    // Not the two period actions beside them: closing and reopening a month
    // moves a status and posts nothing.
    actions: ["closeFiscalYearAction", "reopenFiscalYearAction"],
  },
  {
    file: "src/server/sales/actions.ts",
    actions: ["createSaleAction", "voidSaleAction"],
  },
  {
    file: "src/server/purchases/actions.ts",
    actions: ["createPurchaseAction", "voidPurchaseAction"],
  },
  {
    file: "src/server/returns/actions.ts",
    actions: ["createSalesReturnAction", "createPurchaseReturnAction"],
  },
  {
    file: "src/server/settlements/actions.ts",
    actions: [
      "createReceiptAction",
      "createPaymentAction",
      "voidReceiptAction",
      "voidPaymentAction",
    ],
  },
  {
    file: "src/server/expenses/actions.ts",
    actions: ["createExpenseAction", "voidExpenseAction"],
  },
  {
    file: "src/server/inventory/actions.ts",
    actions: ["createStockAdjustmentAction"],
  },
  { file: "src/server/payroll/actions.ts", actions: ["runPayrollAction"] },
  {
    file: "src/server/banking/actions.ts",
    actions: ["recordFromStatementAction"],
  },
];

/** One exported action's source, from its signature to the next one. */
function bodyOf(file: string, action: string): string | null {
  const text = readFileSync(file, "utf8");
  const start = text.indexOf(`export async function ${action}(`);
  if (start === -1) return null;
  const rest = text.slice(start + 1);
  const next = rest.indexOf("\nexport async function ");
  return next === -1 ? rest : rest.slice(0, next);
}

function resolveImport(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = `src/${spec.slice(2)}`;
  else if (spec.startsWith(".")) {
    base = `${from.split("/").slice(0, -1).join("/")}/${spec}`;
  } else return null;

  const normalised = base
    .split("/")
    .reduce<string[]>((parts, part) => {
      if (part === "." || part === "") return parts;
      if (part === "..") {
        parts.pop();
        return parts;
      }
      parts.push(part);
      return parts;
    }, [])
    .join("/");

  for (const candidate of [`${normalised}.ts`, `${normalised}/index.ts`]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function importsOf(file: string): string[] {
  return [...readFileSync(file, "utf8").matchAll(/from\s+"([^"]+)"/g)]
    .map((match) => resolveImport(match[1]!, file))
    .filter((resolved): resolved is string => resolved !== null);
}

/** Server actions: the entry points a browser can reach directly. */
function actionFiles(): string[] {
  return globSync("src/server/**/*.ts").filter((file) =>
    readFileSync(file, "utf8").startsWith('"use server"'),
  );
}

/**
 * Whether an action file can reach a posting.
 *
 * One hop, not the whole graph. An action calls its own module's service and
 * that service posts, which is the shape every one of these has; following the
 * graph further would drag in `db.ts` and report the whole codebase.
 */
function postingImports(file: string): string[] {
  return importsOf(file).filter((imported) =>
    new RegExp(`${LEDGER}\\s*\\(`).test(readFileSync(imported, "utf8")),
  );
}

describe("the gate in front of the ledger", () => {
  it("finds the writers it is meant to be checking", () => {
    // The detector's own test. A rule that matched nothing would pass the case
    // below by finding nothing to complain about, which is the same green a
    // correct codebase gives and worth telling apart.
    const writers = actionFiles().filter(
      (file) => postingImports(file).length > 0,
    );

    expect(
      writers.length,
      "no action file appears to reach the ledger",
    ).toBeGreaterThan(5);
    expect(writers.map((file) => file.replace(/\\/g, "/"))).toEqual(
      expect.arrayContaining([
        "src/server/sales/actions.ts",
        "src/server/purchases/actions.ts",
        "src/server/accounting/journal-actions.ts",
      ]),
    );
  });

  it("is asked by every action that can post", () => {
    const unguarded: string[] = [];

    for (const file of actionFiles()) {
      const path = file.replace(/\\/g, "/");
      if (EXEMPT.has(path)) continue;

      const posting = postingImports(file);
      if (posting.length === 0) continue;

      if (!readFileSync(file, "utf8").includes(`${GATE}(`)) {
        unguarded.push(
          `${path} — reaches the ledger through ${posting
            .map((imported) => imported.split("/").pop())
            .join(", ")} — and never asks ${GATE}`,
        );
      }
    }

    expect(
      unguarded,
      `these can post to the ledger without asking whether the subscription allows it:\n${unguarded.join(
        "\n",
      )}`,
    ).toEqual([]);
  });

  it("is asked inside each posting action, not merely somewhere in its file", () => {
    const missing: string[] = [];

    for (const { file, actions } of MUST_ASK) {
      for (const action of actions) {
        const body = bodyOf(file, action);
        if (body === null) {
          missing.push(`${file} — ${action} no longer exists under that name`);
          continue;
        }
        if (!body.includes(`${GATE}(`)) {
          missing.push(`${file} — ${action} posts without asking ${GATE}`);
        }
      }
    }

    expect(
      missing,
      `these put a figure into the ledger without asking whether the subscription allows it:\n${missing.join(
        "\n",
      )}`,
    ).toEqual([]);
  });

  it("keeps a reason beside anything held out of the rule", () => {
    // An exemption is a decision somebody made. Without a sentence saying why,
    // the next reader cannot tell it from an oversight — which is what the
    // accounting module looked like.
    for (const [path, reason] of EXEMPT) {
      expect(existsSync(path), `${path} is exempted but no longer exists`).toBe(
        true,
      );
      expect(
        reason.length,
        `${path} is exempted without a reason`,
      ).toBeGreaterThan(20);

      // And it must still be a writer; an exemption for something that cannot
      // post is dead weight that hides the next real one.
      expect(
        postingImports(path).length,
        `${path} no longer reaches the ledger, so its exemption should go`,
      ).toBeGreaterThan(0);
    }
  });
});
