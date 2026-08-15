import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountSubType } from "@prisma/client";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import { trialBalanceIsBalanced } from "@/lib/accounting/double-entry";
import type { RegisterInput } from "@/lib/validation/auth";
import type { BankAccountValues } from "@/lib/validation/banking";
import { registerOwner } from "@/server/auth/registration";
import {
  createBankAccount,
  listBankAccounts,
  bankableAccounts,
  maskAccountNumber,
  BankAccountError,
} from "@/server/banking/bank-account-service";
import { importStatement } from "@/server/banking/statement-import";
import {
  matchTransaction,
  reconciliationView,
  unmatchTransaction,
} from "@/server/banking/reconciliation-service";
import { recordFromStatement } from "@/server/banking/record-from-statement";
import { postJournalEntry } from "@/server/accounting/post-journal-entry";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * Bank reconciliation.
 *
 * The parser and the matcher are unit-tested. What needs a database is
 * everything that could quietly go wrong across two tables: that importing the
 * same statement twice does nothing the second time, that a match is refused
 * unless the two sides genuinely agree, that one company can never see or touch
 * another's statement, and that the reconciliation identity actually holds
 * against real posted entries rather than against arithmetic in a fixture.
 */

const prisma = testDb();
const createdCompanies: string[] = [];
const createdEmails: string[] = [];

function registrationInput(email: string): RegisterInput {
  return {
    account: {
      fullName: "Ravi Prakash",
      email,
      mobile: "9845012345",
      password: "MountainRiver42!",
      confirmPassword: "MountainRiver42!",
      acceptTerms: true,
    },
    business: {
      businessName: `Bank ${uniqueSlug("Mart")}`,
      businessType: "SOLE_PROPRIETORSHIP",
      gstRegistration: "REGULAR",
      gstin: "29AAAPR1234K1ZP",
      pan: "AAAPR1234K",
      addressLine1: "42 Avenue Road",
      city: "Bengaluru",
      stateCode: "29",
      pincode: "560053",
    },
    accounting: {
      fiscalYearStartMonth: 4,
      currency: "INR",
      openingCashBalance: 100_000,
      openingBankBalance: 200_000,
      inventoryMethod: "WEIGHTED_AVERAGE",
      loadDemoData: false,
    },
  };
}

/** A complete `BankAccountValues`, so the tests state only what they care about. */
function bankInput(
  over: { name: string; accountId: string } & Partial<BankAccountValues>,
): BankAccountValues {
  return {
    bankName: undefined,
    accountNumber: undefined,
    ifsc: undefined,
    branchName: undefined,
    type: "CURRENT",
    ...over,
  };
}

type Fixture = {
  companyId: string;
  userId: string;
  actorEmail: string;
  bankAccountId: string;
  ledgerAccountId: string;
};

async function createCompanyWithBank(): Promise<Fixture> {
  const email = `bank-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const result = await registerOwner(registrationInput(email));
  createdCompanies.push(result.companyId);

  const ledger = await prisma.account.findFirstOrThrow({
    where: { companyId: result.companyId, systemKey: SYSTEM_ACCOUNT.BANK },
    select: { id: true },
  });

  const bank = await createBankAccount({
    companyId: result.companyId,
    input: bankInput({
      name: "Current Account — Canara Bank",
      accountId: ledger.id,
      bankName: "Canara Bank",
      accountNumber: "0421201000456",
      ifsc: "CNRB0000421",
      branchName: "Chickpet",
    }),
  });

  return {
    companyId: result.companyId,
    userId: result.userId,
    actorEmail: email,
    bankAccountId: bank.id,
    ledgerAccountId: ledger.id,
  };
}

/** A statement CSV in the shape a bank actually exports. */
function statementCsv(
  rows: {
    date: string;
    description: string;
    out?: string;
    in?: string;
    ref?: string;
  }[],
): string {
  return [
    "Txn Date,Description,Chq/Ref No,Withdrawal Amt,Deposit Amt",
    ...rows.map((row) =>
      [
        row.date,
        row.description,
        row.ref ?? "",
        row.out ?? "",
        row.in ?? "",
      ].join(","),
    ),
  ].join("\n");
}

const importFor = (fixture: Fixture, csv: string) =>
  importStatement({
    companyId: fixture.companyId,
    bankAccountId: fixture.bankAccountId,
    content: csv,
    fileName: "statement.csv",
    userId: fixture.userId,
    actorEmail: fixture.actorEmail,
  });

const viewFor = (fixture: Fixture, from = "2026-04-01", to = "2026-04-30") =>
  reconciliationView({
    companyId: fixture.companyId,
    bankAccountId: fixture.bankAccountId,
    from: new Date(`${from}T00:00:00.000Z`),
    to: new Date(`${to}T00:00:00.000Z`),
  });

/** Posts a payment out of the bank, the way a real entry would look. */
async function postBankPayment(
  fixture: Fixture,
  params: {
    date: string;
    amount: string;
    narration: string;
    reference?: string;
  },
) {
  const expense = await prisma.account.findFirstOrThrow({
    where: {
      companyId: fixture.companyId,
      systemKey: SYSTEM_ACCOUNT.RENT_EXPENSE,
    },
    select: { id: true },
  });

  return prisma.$transaction((tx) =>
    postJournalEntry(tx, {
      companyId: fixture.companyId,
      entryDate: new Date(`${params.date}T00:00:00.000Z`),
      voucherType: "PAYMENT",
      narration: params.narration,
      referenceNo: params.reference ?? null,
      createdById: fixture.userId,
      lines: [
        {
          accountId: expense.id,
          debit: params.amount,
          credit: 0,
          narration: params.narration,
        },
        {
          accountId: fixture.ledgerAccountId,
          debit: 0,
          credit: params.amount,
          narration: params.narration,
        },
      ],
    }),
  );
}

beforeAll(async () => {
  await ensurePlatformData();
}, 120_000);

afterAll(async () => {
  for (const companyId of createdCompanies) await purgeTestCompany(companyId);
  await purgeTestUsers(createdEmails);
  await disconnectTestDb();
}, 120_000);

describe("describing a bank account", () => {
  it("shows only the last four digits back", () => {
    // A full account number is not needed to tell two accounts apart, and a
    // page that prints it is a page somebody screenshots.
    expect(maskAccountNumber("0421201000456")).toBe("••••0456");
    expect(maskAccountNumber(null)).toBeNull();
  });

  it("refuses a ledger account that is not a bank account", async () => {
    const fixture = await createCompanyWithBank();
    const sales = await prisma.account.findFirstOrThrow({
      where: { companyId: fixture.companyId, systemKey: SYSTEM_ACCOUNT.SALES },
      select: { id: true },
    });

    await expect(
      createBankAccount({
        companyId: fixture.companyId,
        input: bankInput({
          name: "Nonsense",
          accountId: sales.id,
        }),
      }),
    ).rejects.toThrow(BankAccountError);
  }, 60_000);

  it("refuses two bank accounts sharing one ledger account", async () => {
    // Sharing would make each reconciliation include the other's movements,
    // and both pages would be wrong in a way that is very hard to see.
    const fixture = await createCompanyWithBank();

    await expect(
      createBankAccount({
        companyId: fixture.companyId,
        input: bankInput({
          name: "A second name for the same account",
          accountId: fixture.ledgerAccountId,
        }),
      }),
    ).rejects.toThrow(/already used/i);
  }, 60_000);

  it("refuses a ledger account belonging to another company", async () => {
    const [mine, theirs] = await Promise.all([
      createCompanyWithBank(),
      createCompanyWithBank(),
    ]);

    await expect(
      createBankAccount({
        companyId: mine.companyId,
        input: bankInput({
          name: "Borrowed",
          accountId: theirs.ledgerAccountId,
        }),
      }),
    ).rejects.toThrow(/does not belong to this business/i);
  }, 90_000);

  it("offers cash and bank accounts, marking the ones already spoken for", async () => {
    const fixture = await createCompanyWithBank();
    const options = await bankableAccounts(fixture.companyId);

    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      const account = await prisma.account.findFirstOrThrow({
        where: { id: option.id },
        select: { subType: true },
      });
      expect(account.subType).toBe(AccountSubType.CASH_AND_BANK);
    }
    expect(
      options.find((option) => option.id === fixture.ledgerAccountId)
        ?.alreadyUsed,
    ).toBe(true);
  }, 60_000);
});

describe("importing a statement", () => {
  it("reads the file and keeps direction the way the books see it", async () => {
    const fixture = await createCompanyWithBank();
    const summary = await importFor(
      fixture,
      statementCsv([
        { date: "05/04/2026", description: "Cash deposit", in: "25000.00" },
        { date: "07/04/2026", description: "Rent paid", out: "18000.00" },
      ]),
    );

    expect(summary.imported).toBe(2);
    expect(summary.skipped).toEqual([]);

    const rows = await prisma.bankTransaction.findMany({
      where: { bankAccountId: fixture.bankAccountId },
      orderBy: { txnDate: "asc" },
      select: { debit: true, credit: true, description: true },
    });

    // The bank's Deposit column arrives as a debit here, because money in
    // increases the asset the books hold.
    expect(rows[0]?.debit.toString()).toBe("25000");
    expect(rows[0]?.credit.toString()).toBe("0");
    expect(rows[1]?.credit.toString()).toBe("18000");
  }, 60_000);

  it("does nothing the second time the same statement is imported", async () => {
    // People re-download statements with overlapping ranges constantly. An
    // importer that appended would double every row in the overlap, and the
    // reconciliation would be wrong by exactly the figure somebody is hunting.
    const fixture = await createCompanyWithBank();
    const csv = statementCsv([
      { date: "05/04/2026", description: "Cash deposit", in: "25000.00" },
      { date: "07/04/2026", description: "Rent paid", out: "18000.00" },
    ]);

    const first = await importFor(fixture, csv);
    const second = await importFor(fixture, csv);

    expect(first.imported).toBe(2);
    expect(second.imported).toBe(0);
    expect(second.duplicates).toBe(2);

    const count = await prisma.bankTransaction.count({
      where: { bankAccountId: fixture.bankAccountId },
    });
    expect(count).toBe(2);
  }, 60_000);

  it("imports only the new rows from an overlapping range", async () => {
    const fixture = await createCompanyWithBank();
    await importFor(
      fixture,
      statementCsv([
        { date: "05/04/2026", description: "Cash deposit", in: "25000.00" },
      ]),
    );

    const second = await importFor(
      fixture,
      statementCsv([
        { date: "05/04/2026", description: "Cash deposit", in: "25000.00" },
        { date: "12/04/2026", description: "Supplier payment", out: "9000.00" },
      ]),
    );

    expect(second.imported).toBe(1);
    expect(second.duplicates).toBe(1);
  }, 60_000);

  it("deduplicates a row repeated inside one file", async () => {
    const fixture = await createCompanyWithBank();
    const summary = await importFor(
      fixture,
      statementCsv([
        { date: "05/04/2026", description: "Cash deposit", in: "25000.00" },
        { date: "05/04/2026", description: "Cash deposit", in: "25000.00" },
      ]),
    );
    expect(summary.imported).toBe(1);
    expect(summary.duplicates).toBe(1);
  }, 60_000);

  it("imports what it can and reports the rows it could not read", async () => {
    const fixture = await createCompanyWithBank();
    const summary = await importFor(
      fixture,
      [
        "Txn Date,Description,Chq/Ref No,Withdrawal Amt,Deposit Amt",
        "05/04/2026,Cash deposit,,,25000.00",
        "rubbish,Bad row,,,500.00",
      ].join("\n"),
    );

    expect(summary.imported).toBe(1);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.skipped[0]?.lineNumber).toBe(3);
  }, 60_000);

  it("refuses to import into another company's bank account", async () => {
    const [mine, theirs] = await Promise.all([
      createCompanyWithBank(),
      createCompanyWithBank(),
    ]);

    await expect(
      importStatement({
        companyId: mine.companyId,
        bankAccountId: theirs.bankAccountId,
        content: statementCsv([
          { date: "05/04/2026", description: "Cash deposit", in: "25000.00" },
        ]),
        userId: mine.userId,
        actorEmail: mine.actorEmail,
      }),
    ).rejects.toThrow(/does not belong to this business/i);

    const count = await prisma.bankTransaction.count({
      where: { bankAccountId: theirs.bankAccountId },
    });
    expect(count).toBe(0);
  }, 90_000);

  it("writes an audit entry naming what was imported", async () => {
    const fixture = await createCompanyWithBank();
    await importFor(
      fixture,
      statementCsv([
        { date: "05/04/2026", description: "Cash deposit", in: "25000.00" },
      ]),
    );

    const log = await prisma.auditLog.findFirst({
      where: {
        companyId: fixture.companyId,
        action: "banking.statement_imported",
      },
      select: { metadata: true },
    });
    expect(log?.metadata).toMatchObject({ imported: 1 });
  }, 60_000);
});

describe("matching", () => {
  it("links a statement line to the entry that produced it", async () => {
    const fixture = await createCompanyWithBank();
    const entry = await postBankPayment(fixture, {
      date: "2026-04-07",
      amount: "18000",
      narration: "April rent",
    });
    await importFor(
      fixture,
      statementCsv([
        { date: "07/04/2026", description: "Rent paid", out: "18000.00" },
      ]),
    );

    const before = await viewFor(fixture);
    expect(before?.unmatchedStatement).toHaveLength(1);
    // The matcher found it on its own, and said why.
    expect(before?.suggestions).toHaveLength(1);
    expect(before?.suggestions[0]?.reason).toMatch(/same date/i);

    await matchTransaction({
      companyId: fixture.companyId,
      bankTransactionId: before!.unmatchedStatement[0]!.id,
      journalEntryId: entry.id,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
    });

    const after = await viewFor(fixture);
    expect(after?.unmatchedStatement).toHaveLength(0);
    expect(after?.statement[0]?.matchedEntryNumber).toBe(entry.entryNumber);
    // The rent entry has left the outstanding list. The opening balance entry
    // is still on it, and correctly so: it is a movement on the bank account
    // in the books that this statement does not cover.
    expect(after?.unmatchedBook.map((row) => row.entryNumber)).not.toContain(
      entry.entryNumber,
    );
  }, 90_000);

  it("refuses a match whose amounts disagree", async () => {
    // Otherwise a difference could be cleared by declaring two unrelated
    // figures to be the same transaction, which is the one thing a
    // reconciliation must never permit.
    const fixture = await createCompanyWithBank();
    const entry = await postBankPayment(fixture, {
      date: "2026-04-07",
      amount: "18000",
      narration: "April rent",
    });
    await importFor(
      fixture,
      statementCsv([
        { date: "07/04/2026", description: "Rent paid", out: "17500.00" },
      ]),
    );

    const view = await viewFor(fixture);
    await expect(
      matchTransaction({
        companyId: fixture.companyId,
        bankTransactionId: view!.unmatchedStatement[0]!.id,
        journalEntryId: entry.id,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
      }),
    ).rejects.toThrow(/have to agree/i);
  }, 90_000);

  it("refuses an entry that never touched this bank account", async () => {
    const fixture = await createCompanyWithBank();
    // A receipt into cash, not into the bank.
    const cash = await prisma.account.findFirstOrThrow({
      where: { companyId: fixture.companyId, systemKey: SYSTEM_ACCOUNT.CASH },
      select: { id: true },
    });
    const capital = await prisma.account.findFirstOrThrow({
      where: {
        companyId: fixture.companyId,
        systemKey: SYSTEM_ACCOUNT.OTHER_INCOME,
      },
      select: { id: true },
    });
    const entry = await prisma.$transaction((tx) =>
      postJournalEntry(tx, {
        companyId: fixture.companyId,
        entryDate: new Date("2026-04-07T00:00:00.000Z"),
        voucherType: "RECEIPT",
        narration: "Cash, not bank",
        createdById: fixture.userId,
        lines: [
          { accountId: cash.id, debit: "5000", credit: 0 },
          { accountId: capital.id, debit: 0, credit: "5000" },
        ],
      }),
    );

    await importFor(
      fixture,
      statementCsv([
        { date: "07/04/2026", description: "Something", in: "5000.00" },
      ]),
    );
    const view = await viewFor(fixture);

    await expect(
      matchTransaction({
        companyId: fixture.companyId,
        bankTransactionId: view!.unmatchedStatement[0]!.id,
        journalEntryId: entry.id,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
      }),
    ).rejects.toThrow(/does not touch this bank account/i);
  }, 90_000);

  it("refuses to match one entry to two statement lines", async () => {
    const fixture = await createCompanyWithBank();
    const entry = await postBankPayment(fixture, {
      date: "2026-04-07",
      amount: "1000",
      narration: "One payment",
    });
    await importFor(
      fixture,
      statementCsv([
        { date: "07/04/2026", description: "First", out: "1000.00" },
        { date: "07/04/2026", description: "Second", out: "1000.00" },
      ]),
    );

    const view = await viewFor(fixture);
    await matchTransaction({
      companyId: fixture.companyId,
      bankTransactionId: view!.unmatchedStatement[0]!.id,
      journalEntryId: entry.id,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
    });

    await expect(
      matchTransaction({
        companyId: fixture.companyId,
        bankTransactionId: view!.unmatchedStatement[1]!.id,
        journalEntryId: entry.id,
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
      }),
    ).rejects.toThrow(/already matched/i);
  }, 90_000);

  it("cannot match across companies", async () => {
    const [mine, theirs] = await Promise.all([
      createCompanyWithBank(),
      createCompanyWithBank(),
    ]);
    await importFor(
      theirs,
      statementCsv([
        { date: "07/04/2026", description: "Theirs", out: "1000.00" },
      ]),
    );
    const theirView = await viewFor(theirs);
    const entry = await postBankPayment(mine, {
      date: "2026-04-07",
      amount: "1000",
      narration: "Mine",
    });

    await expect(
      matchTransaction({
        companyId: mine.companyId,
        bankTransactionId: theirView!.unmatchedStatement[0]!.id,
        journalEntryId: entry.id,
        userId: mine.userId,
        actorEmail: mine.actorEmail,
      }),
    ).rejects.toThrow(/does not belong to this business/i);
  }, 120_000);

  it("unmatching leaves both records exactly as they were", async () => {
    const fixture = await createCompanyWithBank();
    const entry = await postBankPayment(fixture, {
      date: "2026-04-07",
      amount: "18000",
      narration: "April rent",
    });
    await importFor(
      fixture,
      statementCsv([
        { date: "07/04/2026", description: "Rent paid", out: "18000.00" },
      ]),
    );
    const view = await viewFor(fixture);
    const transactionId = view!.unmatchedStatement[0]!.id;

    const beforeRow = await prisma.bankTransaction.findFirstOrThrow({
      where: { id: transactionId },
      select: { debit: true, credit: true, description: true },
    });

    await matchTransaction({
      companyId: fixture.companyId,
      bankTransactionId: transactionId,
      journalEntryId: entry.id,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
    });
    await unmatchTransaction({
      companyId: fixture.companyId,
      bankTransactionId: transactionId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
    });

    const afterRow = await prisma.bankTransaction.findFirstOrThrow({
      where: { id: transactionId },
      select: {
        debit: true,
        credit: true,
        description: true,
        journalEntryId: true,
        reconciledAt: true,
      },
    });
    expect(afterRow.debit.toString()).toBe(beforeRow.debit.toString());
    expect(afterRow.credit.toString()).toBe(beforeRow.credit.toString());
    expect(afterRow.description).toBe(beforeRow.description);
    expect(afterRow.journalEntryId).toBeNull();
    expect(afterRow.reconciledAt).toBeNull();

    // And the entry itself is untouched — a reconciliation never edits the
    // ledger.
    const stillPosted = await prisma.journalEntry.findFirstOrThrow({
      where: { id: entry.id },
      select: { status: true, totalDebit: true },
    });
    expect(stillPosted.status).toBe("POSTED");
    expect(stillPosted.totalDebit.toString()).toBe("18000");
  }, 90_000);
});

describe("the reconciliation statement", () => {
  it("balances when every difference is a timing difference", async () => {
    // The identity the whole module rests on: books minus what the bank has not
    // seen equals statement minus what the books have not seen.
    const fixture = await createCompanyWithBank();

    // A cheque written on the 28th that the bank has not paid out yet.
    await postBankPayment(fixture, {
      date: "2026-04-28",
      amount: "7000",
      narration: "Cheque to supplier",
    });
    // And one that both sides agree on.
    const cleared = await postBankPayment(fixture, {
      date: "2026-04-07",
      amount: "18000",
      narration: "April rent",
    });

    await importFor(
      fixture,
      statementCsv([
        { date: "07/04/2026", description: "Rent paid", out: "18000.00" },
      ]),
    );

    const view = await viewFor(fixture);
    await matchTransaction({
      companyId: fixture.companyId,
      bankTransactionId: view!.statement[0]!.id,
      journalEntryId: cleared.id,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
    });

    const after = await viewFor(fixture);
    // The uncleared cheque is outstanding, and so is the opening balance entry
    // — the statement imported here starts after it. Both are genuine timing
    // differences rather than errors, which is exactly the point: the identity
    // has to absorb them without anything left over.
    expect(after?.unmatchedBook.map((row) => row.narration)).toContain(
      "Cheque to supplier",
    );
    expect(after?.difference.unexplained.toString()).toBe("0");

    // And the arithmetic is the classic statement, not a plausible-looking
    // rearrangement of it: books less what the bank has not seen equals
    // statement less what the books have not seen.
    const { perBooks, perStatement, unpresentedNet, unrecordedNet } =
      after!.difference;
    expect(perBooks.minus(unpresentedNet).toString()).toBe(
      perStatement.minus(unrecordedNet).toString(),
    );
  }, 120_000);

  it("reports a genuine gap rather than absorbing it", async () => {
    // A statement line nobody has recorded and nobody has matched: the books
    // and the bank really do disagree, and the page has to say so.
    const fixture = await createCompanyWithBank();
    await importFor(
      fixture,
      statementCsv([
        { date: "10/04/2026", description: "Bank charges", out: "236.00" },
      ]),
    );

    const view = await viewFor(fixture);
    // Unmatched on the statement side accounts for it exactly, so the
    // identity still holds — the difference is *explained*, not absent.
    expect(view?.difference.unexplained.toString()).toBe("0");
    expect(view?.unmatchedStatement).toHaveLength(1);
    expect(view?.difference.unrecordedNet.toString()).toBe("-236");
  }, 60_000);

  it("counts the opening balance, not just the movements in the window", async () => {
    // The book balance has to include everything before the window opened.
    // Summing only what is on screen would report a bank balance of whatever
    // happened this month, which is not a bank balance.
    const fixture = await createCompanyWithBank();
    const view = await viewFor(fixture);
    expect(Number(view?.difference.perBooks)).toBe(200_000);
  }, 60_000);

  it("says when nothing has been imported, rather than reporting nil", async () => {
    const fixture = await createCompanyWithBank();
    const view = await viewFor(fixture);
    expect(view?.neverImported).toBe(true);
  }, 60_000);

  it("never shows another company's statement lines", async () => {
    const [mine, theirs] = await Promise.all([
      createCompanyWithBank(),
      createCompanyWithBank(),
    ]);
    await importFor(
      theirs,
      statementCsv([
        { date: "07/04/2026", description: "Theirs alone", out: "1234.00" },
      ]),
    );

    // Asking for their bank account id under my company finds nothing at all.
    const borrowed = await reconciliationView({
      companyId: mine.companyId,
      bankAccountId: theirs.bankAccountId,
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-04-30T00:00:00.000Z"),
    });
    expect(borrowed).toBeNull();

    const own = await viewFor(mine);
    expect(own?.statement).toHaveLength(0);
  }, 120_000);
});

describe("recording what only the bank knew", () => {
  it("posts a bank charge through the accounting engine and matches it", async () => {
    const fixture = await createCompanyWithBank();
    await importFor(
      fixture,
      statementCsv([
        { date: "10/04/2026", description: "Quarterly charges", out: "236.00" },
      ]),
    );
    const view = await viewFor(fixture);

    const posted = await recordFromStatement({
      companyId: fixture.companyId,
      bankTransactionId: view!.unmatchedStatement[0]!.id,
      kind: "BANK_CHARGE",
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
    });

    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { id: posted.entryId },
      select: {
        totalDebit: true,
        totalCredit: true,
        lines: {
          select: {
            debit: true,
            credit: true,
            account: { select: { systemKey: true } },
          },
        },
      },
    });

    expect(entry.totalDebit.toString()).toBe("236");
    expect(entry.totalCredit.toString()).toBe("236");
    const charge = entry.lines.find(
      (line) => line.account.systemKey === SYSTEM_ACCOUNT.BANK_CHARGES,
    );
    const bank = entry.lines.find(
      (line) => line.account.systemKey === SYSTEM_ACCOUNT.BANK,
    );
    // The charge is a cost and the bank balance falls by it.
    expect(charge?.debit.toString()).toBe("236");
    expect(bank?.credit.toString()).toBe("236");

    // And it was matched in the same step, so it cannot be recorded twice.
    const after = await viewFor(fixture);
    expect(after?.unmatchedStatement).toHaveLength(0);
    expect(after?.difference.unexplained.toString()).toBe("0");
  }, 90_000);

  it("refuses to record a charge against money coming in", async () => {
    // Posting it anyway would produce an entry that balances and is backwards.
    const fixture = await createCompanyWithBank();
    await importFor(
      fixture,
      statementCsv([
        { date: "10/04/2026", description: "Interest credited", in: "412.00" },
      ]),
    );
    const view = await viewFor(fixture);

    await expect(
      recordFromStatement({
        companyId: fixture.companyId,
        bankTransactionId: view!.unmatchedStatement[0]!.id,
        kind: "BANK_CHARGE",
        userId: fixture.userId,
        actorEmail: fixture.actorEmail,
      }),
    ).rejects.toThrow(/money out/i);
  }, 90_000);

  it("posts interest received as income", async () => {
    const fixture = await createCompanyWithBank();
    await importFor(
      fixture,
      statementCsv([
        { date: "10/04/2026", description: "Interest credited", in: "412.00" },
      ]),
    );
    const view = await viewFor(fixture);

    const posted = await recordFromStatement({
      companyId: fixture.companyId,
      bankTransactionId: view!.unmatchedStatement[0]!.id,
      kind: "INTEREST_RECEIVED",
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
    });

    const lines = await prisma.journalLine.findMany({
      where: { journalEntryId: posted.entryId },
      select: {
        debit: true,
        credit: true,
        account: { select: { systemKey: true } },
      },
    });
    const income = lines.find(
      (line) => line.account.systemKey === SYSTEM_ACCOUNT.OTHER_INCOME,
    );
    expect(income?.credit.toString()).toBe("412");
  }, 90_000);

  it("cannot record against another company's statement line", async () => {
    const [mine, theirs] = await Promise.all([
      createCompanyWithBank(),
      createCompanyWithBank(),
    ]);
    await importFor(
      theirs,
      statementCsv([
        { date: "10/04/2026", description: "Charges", out: "236.00" },
      ]),
    );
    const theirView = await viewFor(theirs);

    await expect(
      recordFromStatement({
        companyId: mine.companyId,
        bankTransactionId: theirView!.unmatchedStatement[0]!.id,
        kind: "BANK_CHARGE",
        userId: mine.userId,
        actorEmail: mine.actorEmail,
      }),
    ).rejects.toThrow(/does not belong to this business/i);
  }, 120_000);

  it("leaves the books balanced after everything above", async () => {
    const fixture = await createCompanyWithBank();
    await importFor(
      fixture,
      statementCsv([
        { date: "10/04/2026", description: "Charges", out: "236.00" },
        { date: "11/04/2026", description: "Interest", in: "412.00" },
      ]),
    );
    const view = await viewFor(fixture);
    await recordFromStatement({
      companyId: fixture.companyId,
      bankTransactionId: view!.unmatchedStatement[0]!.id,
      kind: "BANK_CHARGE",
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
    });
    await recordFromStatement({
      companyId: fixture.companyId,
      bankTransactionId: view!.unmatchedStatement[1]!.id,
      kind: "INTEREST_RECEIVED",
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
    });

    const grouped = await prisma.journalLine.groupBy({
      by: ["accountId"],
      where: { companyId: fixture.companyId, status: "POSTED" },
      _sum: { debit: true, credit: true },
    });
    const trial = trialBalanceIsBalanced(
      grouped.map((line) => ({
        debit: line._sum.debit ?? 0,
        credit: line._sum.credit ?? 0,
      })),
    );
    expect(trial.difference.toString()).toBe("0");
  }, 120_000);
});

describe("the bank account list", () => {
  it("counts what is still unmatched", async () => {
    const fixture = await createCompanyWithBank();
    await importFor(
      fixture,
      statementCsv([
        { date: "05/04/2026", description: "Deposit", in: "25000.00" },
        { date: "07/04/2026", description: "Rent", out: "18000.00" },
      ]),
    );

    const accounts = await listBankAccounts(fixture.companyId);
    const account = accounts.find((row) => row.id === fixture.bankAccountId);
    expect(account?.unreconciledCount).toBe(2);
    // The number on the list is a fact about imported rows, not an estimate.
    expect(account?.accountNumber).toBe("••••0456");
  }, 60_000);

  it("lists only this company's accounts", async () => {
    const [mine, theirs] = await Promise.all([
      createCompanyWithBank(),
      createCompanyWithBank(),
    ]);
    const accounts = await listBankAccounts(mine.companyId);
    expect(accounts.map((row) => row.id)).toContain(mine.bankAccountId);
    expect(accounts.map((row) => row.id)).not.toContain(theirs.bankAccountId);
  }, 90_000);
});
