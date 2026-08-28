import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Something that changes a tenant's records says so in the audit log.
 *
 * `action-authorization-coverage` proves nobody forgot to ask *who is calling*.
 * This proves nobody forgot to write down *what they did*. The two fail
 * differently: an action with no permission check is open, and an action with
 * no audit entry is invisible — it works exactly as intended, forever, and the
 * only cost arrives on the day somebody asks who changed something.
 *
 * Two gaps found the first time this was run, both in modules that otherwise
 * audit everything:
 *
 *   • **Adding a bank account.** Importing a statement is recorded. Matching
 *     one line to one journal entry is recorded, and so is unmatching it, and
 *     so is recording a receipt from a line. Creating the account those four
 *     hang off — the record that names a bank, an account number, an IFSC and
 *     the ledger account every later reconciliation reads — was not.
 *   • **Resending a verification email.** Asking for a password reset link is
 *     recorded; asking for a verification link was not, and the two issue the
 *     same kind of thing. That call also consumes every outstanding
 *     verification token before minting a new one, so an unrecorded one is a
 *     credential rotated with nothing to say it happened.
 *
 * Neither looked wrong. Both sat among siblings that did it correctly, which is
 * the shape this file exists for: the rule is obvious in the module and
 * invisible in the function.
 */

/**
 * Writers that record nothing, and why.
 *
 * Named rather than inferred, for the reason the authorization sweep gives: an
 * omission and a decision look identical in a codebase, and only one of them
 * should pass.
 *
 * Almost all of these are one kind of thing — plumbing a business action calls,
 * where the action above is what somebody would search the log for. A journal
 * entry has no audit row of its own because the sale that posted it does, and
 * a log with both would say the same thing twice.
 */
const NOT_AUDITED: Record<string, string> = {
  postJournalEntry:
    "The sole funnel every posting path runs through. The sale, bill, expense or void above it is the recorded act; the entry is how it was carried out.",
  writeGstRows:
    "Writes the register rows for a document the caller has already recorded.",
  reversePostedEntry:
    "The shared half of every void. Each void records its own entry naming the reversal it produced.",
  recordOutward:
    "Moves stock for a document the caller records. The movement ledger is itself append-only and names its source.",
  recordInward: "As `recordOutward`.",
  allocateDocumentNumber:
    "Hands out the next number inside the caller's transaction. A rolled-back document releases its number, and an audit row for one that never existed would be a lie.",
  createFiscalYear:
    "Opens a year on demand when a document is dated into it. Nobody performed it; `ensureFiscalYearFor` is called by the posting path.",
  reconcileCompanyChart:
    "Brings an existing chart up to the current template. Runs as maintenance rather than as anybody's action.",
  provisionCompany:
    "Builds a company's chart, branches, sequences and periods. The registration that called it records `auth.register`, and there is no company to scope a row to until this returns.",
  purgeCompany:
    "Deletes the company, the audit log included. A row written into a table that is about to be dropped records nothing.",
  purgeOrphanedUsers:
    "Housekeeping for users left with no membership after a purge.",
  createSession:
    "Sign-in records `auth.sign_in`; the session row is how that is carried out.",
  setSessionCompany: "Switching company records `company.switched`.",
  revokeAllSessions:
    "Called by `signOutEverywhereAction`, which records `auth.sessions_revoked`.",
  pruneExpiredSessions: "Housekeeping. Nobody performed it.",
  markRead:
    "Marks a notification as seen by the person looking at it. Reading is not a change to the business's records.",
  runAudit:
    "The auditor's own findings. Its output is a report somebody reads, not an edit to the books.",
  settleFinding:
    "Dismisses or resolves one of those findings. The finding row carries who settled it and when.",
  askAccountant:
    "Writes the conversation transcript, which is itself the record — every turn is stored with the tool calls behind it.",
  completeTurn:
    "Does not touch the database. The Anthropic client's `messages.create` matches the write pattern by name only.",
};

/** A Prisma mutation, by any of the client names used in this codebase. */
const WRITE =
  /\b(?:prisma|tx|client|db)\.[a-zA-Z]+\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/;

const EXPORTED = /^export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/gm;

/**
 * One exported function's source.
 *
 * Bounded by the closing brace in the first column, which is where Prettier
 * puts the end of a top-level function and nowhere else. The obvious
 * alternatives are both wrong in ways that matter: a fixed window runs past the
 * end and borrows the next function's audit call, and brace-matching from the
 * first `{` matches the *parameter object type* on every function in this
 * codebase that takes named parameters — which is nearly all of them, and which
 * silently hid the bank account gap when it was tried.
 *
 * `endsAtColumnZero` below proves the assumption still holds rather than
 * trusting it.
 */
function bodyOf(source: string, start: number): string {
  const end = source.slice(start).search(/^\}$/m);
  return end === -1
    ? source.slice(start)
    : source.slice(start, start + end + 1);
}

type Writer = { file: string; line: number; name: string; audits: boolean };

function writers(): Writer[] {
  const found: Writer[] = [];
  for (const file of globSync("src/server/**/*.ts", { cwd: process.cwd() })) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(EXPORTED)) {
      const body = bodyOf(source, match.index);
      if (!WRITE.test(body)) continue;
      found.push({
        file,
        line: source.slice(0, match.index).split("\n").length,
        name: match[1]!,
        audits: body.includes("recordAuditLog"),
      });
    }
  }
  return found;
}

describe("audit coverage", () => {
  const found = writers();

  it("finds enough writers for this to mean anything", () => {
    // A scan that stops matching would make every check below vacuously true.
    expect(found.length).toBeGreaterThanOrEqual(40);
    expect(found.some((writer) => writer.audits)).toBe(true);
    expect(found.some((writer) => !writer.audits)).toBe(true);
  });

  it("ends a function where Prettier ends it", () => {
    // The bound the scan depends on. If the formatter ever stops closing a
    // top-level function at column zero, every body above runs to the end of
    // its file and this file starts passing for the wrong reason.
    const source = readFileSync(
      "src/server/banking/bank-account-service.ts",
      "utf8",
    );
    const at = source.indexOf("export async function createBankAccount");
    const body = bodyOf(source, at);

    expect(body).toContain("prisma.bankAccount.create");
    // The next exported function's name must not be inside it.
    expect(body).not.toContain("export async function getBankAccount");
  });

  it("records every change to a tenant's records", () => {
    const silent = found
      .filter((writer) => !writer.audits && !(writer.name in NOT_AUDITED))
      .map((writer) => `${writer.file}:${writer.line} ${writer.name}`);

    expect(silent).toEqual([]);
  });

  it("keeps the exemption list honest", () => {
    // An exemption for a function that has since started auditing, been
    // renamed, or stopped writing is a claim nobody has checked in a while.
    const stale = Object.keys(NOT_AUDITED).filter(
      (name) => !found.some((writer) => writer.name === name && !writer.audits),
    );

    expect(stale).toEqual([]);
  });

  it("gives every recorded action a name somebody can read", () => {
    // A log row reading `banking.account_created` is only marginally better
    // than no row. The two actions this file found were added to the label map
    // at the same time as the calls that write them.
    const labels = readFileSync("src/lib/audit/activity.ts", "utf8");
    expect(labels).toContain('"banking.account_created"');
    expect(labels).toContain('"auth.verification_resent"');
  });
});
