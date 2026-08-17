import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VoucherType } from "@prisma/client";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import { provisionCompany } from "@/server/provisioning/company-provisioner";
import { postJournalEntry } from "@/server/accounting/post-journal-entry";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * These tests exercise the database guarantees directly.
 *
 * The application validates before it writes, but that validation is only one
 * of two layers. What is asserted here is the second: that PostgreSQL itself
 * refuses to hold an unbalanced ledger, even when the application layer is
 * bypassed entirely. Every write below goes straight through Prisma, skipping
 * the engine's checks, precisely so the constraints are what is under test.
 */

const prisma = testDb();
const ENTRY_DATE = new Date("2026-06-15T00:00:00.000Z");

let companyId: string;
let accounts: Map<string, string>;
let fiscalPeriodId: string;
let fiscalYearId: string;

const accountId = (key: string) => {
  const id = accounts.get(key);
  if (!id) throw new Error(`Missing system account ${key}`);
  return id;
};

beforeAll(async () => {
  await ensurePlatformData();

  const provisioned = await prisma.$transaction(
    (tx) =>
      provisionCompany(tx, {
        name: "Integrity Test Co",
        slug: uniqueSlug("integrity"),
        stateCode: "29",
        asOf: ENTRY_DATE,
      }),
    { timeout: 60_000 },
  );

  companyId = provisioned.companyId;
  accounts = provisioned.accountsBySystemKey;
  fiscalYearId = provisioned.fiscalYearId;

  const period = await prisma.fiscalPeriod.findFirstOrThrow({
    where: {
      companyId,
      startDate: { lte: ENTRY_DATE },
      endDate: { gte: ENTRY_DATE },
    },
    select: { id: true },
  });
  fiscalPeriodId = period.id;
}, 90_000);

afterAll(async () => {
  if (companyId) await purgeTestCompany(companyId);
  await disconnectTestDb();
});

/** Writes an entry straight to the database, bypassing the posting engine. */
async function rawEntry(
  overrides: {
    status?: "DRAFT" | "POSTED";
    totalDebit?: string;
    totalCredit?: string;
    lines: Array<{ accountId: string; debit?: string; credit?: string }>;
  },
  entryNumber = `RAW-${Math.random().toString(36).slice(2, 10)}`,
) {
  const status = overrides.status ?? "POSTED";
  return prisma.journalEntry.create({
    data: {
      companyId,
      fiscalYearId,
      fiscalPeriodId,
      entryNumber,
      entryDate: ENTRY_DATE,
      voucherType: VoucherType.JOURNAL,
      status,
      totalDebit: overrides.totalDebit ?? "0",
      totalCredit: overrides.totalCredit ?? "0",
      postedAt: status === "POSTED" ? new Date() : null,
      lines: {
        create: overrides.lines.map((line, index) => ({
          companyId,
          accountId: line.accountId,
          lineNumber: index + 1,
          debit: line.debit ?? "0",
          credit: line.credit ?? "0",
          entryDate: ENTRY_DATE,
          status,
        })),
      },
    },
    select: { id: true, entryNumber: true },
  });
}

describe("provisioning", () => {
  it("creates a complete, usable chart of accounts", async () => {
    const [accountCount, groupCount, periodCount, taxCount] = await Promise.all(
      [
        prisma.account.count({ where: { companyId } }),
        prisma.accountGroup.count({ where: { companyId } }),
        prisma.fiscalPeriod.count({ where: { companyId } }),
        prisma.taxRate.count({ where: { companyId } }),
      ],
    );

    expect(accountCount).toBeGreaterThan(40);
    expect(groupCount).toBeGreaterThan(15);
    expect(periodCount).toBe(12);
    expect(taxCount).toBe(5);
  });

  it("copies the system roles into the company", async () => {
    const roles = await prisma.role.findMany({
      where: { companyId },
      select: { key: true, permissions: { select: { permissionId: true } } },
    });

    expect(roles).toHaveLength(6);
    const owner = roles.find((role) => role.key === "owner");
    expect(owner?.permissions.length).toBeGreaterThan(50);

    const cashier = roles.find((role) => role.key === "cashier");
    expect(cashier?.permissions.length).toBeLessThan(
      owner?.permissions.length ?? 0,
    );
  });

  it("marks exactly one fiscal year current and one branch primary", async () => {
    expect(
      await prisma.fiscalYear.count({ where: { companyId, isCurrent: true } }),
    ).toBe(1);
    expect(
      await prisma.branch.count({ where: { companyId, isPrimary: true } }),
    ).toBe(1);
  });
});

describe("journal line constraints", () => {
  it("rejects a line with both a debit and a credit", async () => {
    await expect(
      rawEntry({
        totalDebit: "100",
        totalCredit: "100",
        lines: [
          {
            accountId: accountId(SYSTEM_ACCOUNT.CASH),
            debit: "100",
            credit: "40",
          },
          { accountId: accountId(SYSTEM_ACCOUNT.SALES), credit: "60" },
        ],
      }),
    ).rejects.toThrow(/journal_lines_single_sided/i);
  });

  it("rejects a line with neither a debit nor a credit", async () => {
    await expect(
      rawEntry({
        totalDebit: "100",
        totalCredit: "100",
        lines: [
          { accountId: accountId(SYSTEM_ACCOUNT.CASH), debit: "100" },
          { accountId: accountId(SYSTEM_ACCOUNT.SALES), credit: "100" },
          { accountId: accountId(SYSTEM_ACCOUNT.OTHER_INCOME) },
        ],
      }),
    ).rejects.toThrow(/journal_lines_single_sided/i);
  });

  it("rejects a negative amount", async () => {
    await expect(
      rawEntry({
        totalDebit: "100",
        totalCredit: "100",
        lines: [
          { accountId: accountId(SYSTEM_ACCOUNT.CASH), debit: "-100" },
          { accountId: accountId(SYSTEM_ACCOUNT.SALES), credit: "100" },
        ],
      }),
    ).rejects.toThrow(/non_negative|single_sided/i);
  });
});

describe("journal entry balance enforcement", () => {
  it("rejects a posted entry whose lines do not balance", async () => {
    await expect(
      rawEntry({
        totalDebit: "100",
        totalCredit: "100",
        lines: [
          { accountId: accountId(SYSTEM_ACCOUNT.CASH), debit: "100" },
          { accountId: accountId(SYSTEM_ACCOUNT.SALES), credit: "90" },
        ],
      }),
    ).rejects.toThrow(/does not balance|disagree/i);
  });

  it("rejects an entry off by a single paisa", async () => {
    await expect(
      rawEntry({
        totalDebit: "1000.0000",
        totalCredit: "999.9900",
        lines: [
          { accountId: accountId(SYSTEM_ACCOUNT.CASH), debit: "1000.0000" },
          { accountId: accountId(SYSTEM_ACCOUNT.SALES), credit: "999.9900" },
        ],
      }),
    ).rejects.toThrow(/journal_entries_balanced_when_posted|does not balance/i);
  });

  it("rejects control totals that disagree with the lines", async () => {
    await expect(
      rawEntry({
        totalDebit: "500",
        totalCredit: "500",
        lines: [
          { accountId: accountId(SYSTEM_ACCOUNT.CASH), debit: "100" },
          { accountId: accountId(SYSTEM_ACCOUNT.SALES), credit: "100" },
        ],
      }),
    ).rejects.toThrow(/disagree/i);
  });

  it("rejects a posted entry with only one line", async () => {
    await expect(
      rawEntry({
        totalDebit: "100",
        totalCredit: "0",
        lines: [{ accountId: accountId(SYSTEM_ACCOUNT.CASH), debit: "100" }],
      }),
    ).rejects.toThrow(
      /double entry requires at least two|balanced_when_posted/i,
    );
  });

  it("accepts a balanced posted entry", async () => {
    const created = await rawEntry({
      totalDebit: "5000",
      totalCredit: "5000",
      lines: [
        { accountId: accountId(SYSTEM_ACCOUNT.CASH), debit: "5000" },
        { accountId: accountId(SYSTEM_ACCOUNT.SALES), credit: "5000" },
      ],
    });

    expect(created.id).toBeTruthy();
  });

  it("allows a draft to be incomplete while it is still being edited", async () => {
    const draft = await rawEntry({
      status: "DRAFT",
      totalDebit: "100",
      totalCredit: "0",
      lines: [{ accountId: accountId(SYSTEM_ACCOUNT.CASH), debit: "100" }],
    });

    expect(draft.id).toBeTruthy();
    // A draft can still be deleted; only posted history is protected.
    await prisma.journalEntry.delete({ where: { id: draft.id } });
  });
});

describe("immutability of posted entries", () => {
  it("refuses to change a posted entry's amounts", async () => {
    const entry = await postJournalEntry(prisma, {
      companyId,
      entryDate: ENTRY_DATE,
      voucherType: VoucherType.JOURNAL,
      lines: [
        { accountId: accountId(SYSTEM_ACCOUNT.CASH), debit: 2500 },
        { accountId: accountId(SYSTEM_ACCOUNT.SALES), credit: 2500 },
      ],
    });

    await expect(
      prisma.journalEntry.update({
        where: { id: entry.id },
        data: { totalDebit: "9999", totalCredit: "9999" },
      }),
    ).rejects.toThrow(/immutable/i);
  });

  it("refuses to change a posted entry's date", async () => {
    const entry = await postJournalEntry(prisma, {
      companyId,
      entryDate: ENTRY_DATE,
      voucherType: VoucherType.JOURNAL,
      lines: [
        { accountId: accountId(SYSTEM_ACCOUNT.CASH), debit: 1200 },
        { accountId: accountId(SYSTEM_ACCOUNT.SALES), credit: 1200 },
      ],
    });

    await expect(
      prisma.journalEntry.update({
        where: { id: entry.id },
        data: { entryDate: new Date("2026-07-01T00:00:00.000Z") },
      }),
    ).rejects.toThrow(/immutable/i);
  });

  it("refuses to delete a posted entry", async () => {
    const entry = await postJournalEntry(prisma, {
      companyId,
      entryDate: ENTRY_DATE,
      voucherType: VoucherType.JOURNAL,
      lines: [
        { accountId: accountId(SYSTEM_ACCOUNT.CASH), debit: 700 },
        { accountId: accountId(SYSTEM_ACCOUNT.SALES), credit: 700 },
      ],
    });

    await expect(
      prisma.journalEntry.delete({ where: { id: entry.id } }),
    ).rejects.toThrow(/cannot be deleted|reverse or void/i);
  });

  it("refuses to modify a line belonging to a posted entry", async () => {
    const entry = await postJournalEntry(prisma, {
      companyId,
      entryDate: ENTRY_DATE,
      voucherType: VoucherType.JOURNAL,
      lines: [
        { accountId: accountId(SYSTEM_ACCOUNT.CASH), debit: 450 },
        { accountId: accountId(SYSTEM_ACCOUNT.SALES), credit: 450 },
      ],
    });

    const line = await prisma.journalLine.findFirstOrThrow({
      where: { journalEntryId: entry.id },
      select: { id: true },
    });

    await expect(
      prisma.journalLine.update({
        where: { id: line.id },
        data: { debit: "999" },
      }),
    ).rejects.toThrow(/cannot be modified/i);
  });

  it("permits the POSTED → VOIDED transition with a reason", async () => {
    const entry = await postJournalEntry(prisma, {
      companyId,
      entryDate: ENTRY_DATE,
      voucherType: VoucherType.JOURNAL,
      lines: [
        { accountId: accountId(SYSTEM_ACCOUNT.CASH), debit: 300 },
        { accountId: accountId(SYSTEM_ACCOUNT.SALES), credit: 300 },
      ],
    });

    const voided = await prisma.journalEntry.update({
      where: { id: entry.id },
      data: {
        status: "VOIDED",
        voidedAt: new Date(),
        voidReason: "Duplicate entry raised in error",
      },
      select: { status: true },
    });

    expect(voided.status).toBe("VOIDED");
  });

  it("refuses to void without recording a reason", async () => {
    const entry = await postJournalEntry(prisma, {
      companyId,
      entryDate: ENTRY_DATE,
      voucherType: VoucherType.JOURNAL,
      lines: [
        { accountId: accountId(SYSTEM_ACCOUNT.CASH), debit: 310 },
        { accountId: accountId(SYSTEM_ACCOUNT.SALES), credit: 310 },
      ],
    });

    await expect(
      prisma.journalEntry.update({
        where: { id: entry.id },
        data: { status: "VOIDED", voidedAt: new Date() },
      }),
    ).rejects.toThrow(/void_requires_reason/i);
  });
});

describe("audit log append-only guarantee", () => {
  it("accepts an insert", async () => {
    const log = await prisma.auditLog.create({
      data: {
        companyId,
        action: "TEST_ACTION",
        module: "Testing",
        entityType: "JournalEntry",
      },
      select: { id: true },
    });
    expect(log.id).toBeTruthy();
  });

  it("refuses an update", async () => {
    const log = await prisma.auditLog.create({
      data: { companyId, action: "IMMUTABLE_CHECK", module: "Testing" },
      select: { id: true },
    });

    await expect(
      prisma.auditLog.update({
        where: { id: log.id },
        data: { action: "TAMPERED" },
      }),
    ).rejects.toThrow(/append-only/i);
  });

  it("refuses a delete", async () => {
    const log = await prisma.auditLog.create({
      data: { companyId, action: "DELETE_CHECK", module: "Testing" },
      select: { id: true },
    });

    await expect(
      prisma.auditLog.delete({ where: { id: log.id } }),
    ).rejects.toThrow(/append-only/i);
  });
});

describe("posting engine", () => {
  it("numbers entries sequentially without gaps", async () => {
    const numbers: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const entry = await postJournalEntry(prisma, {
        companyId,
        entryDate: ENTRY_DATE,
        voucherType: VoucherType.JOURNAL,
        lines: [
          { accountId: accountId(SYSTEM_ACCOUNT.CASH), debit: 10 },
          { accountId: accountId(SYSTEM_ACCOUNT.SALES), credit: 10 },
        ],
      });
      numbers.push(entry.entryNumber);
    }

    const sequence = numbers.map((number) => Number(number.replace("JV-", "")));
    expect(sequence[1]).toBe((sequence[0] ?? 0) + 1);
    expect(sequence[2]).toBe((sequence[1] ?? 0) + 1);
  });

  it("does not consume a number when the transaction rolls back", async () => {
    const before = await prisma.documentSequence.findFirstOrThrow({
      where: { companyId, key: "JOURNAL" },
      select: { nextValue: true },
    });

    await expect(
      prisma.$transaction(async (tx) => {
        await postJournalEntry(tx, {
          companyId,
          entryDate: ENTRY_DATE,
          voucherType: VoucherType.JOURNAL,
          lines: [
            { accountId: accountId(SYSTEM_ACCOUNT.CASH), debit: 55 },
            { accountId: accountId(SYSTEM_ACCOUNT.SALES), credit: 55 },
          ],
        });
        throw new Error("simulated downstream failure");
      }),
    ).rejects.toThrow("simulated downstream failure");

    const after = await prisma.documentSequence.findFirstOrThrow({
      where: { companyId, key: "JOURNAL" },
      select: { nextValue: true },
    });

    // A gap in an invoice series is exactly what a tax officer asks about.
    expect(after.nextValue).toBe(before.nextValue);
  });

  it("condenses repeated postings before writing", async () => {
    const entry = await postJournalEntry(prisma, {
      companyId,
      entryDate: ENTRY_DATE,
      voucherType: VoucherType.SALES,
      lines: [
        { accountId: accountId(SYSTEM_ACCOUNT.CASH), debit: "5900" },
        { accountId: accountId(SYSTEM_ACCOUNT.SALES), credit: "5000" },
        { accountId: accountId(SYSTEM_ACCOUNT.GST_OUTPUT_CGST), credit: "225" },
        { accountId: accountId(SYSTEM_ACCOUNT.GST_OUTPUT_CGST), credit: "225" },
        { accountId: accountId(SYSTEM_ACCOUNT.GST_OUTPUT_SGST), credit: "450" },
      ],
    });

    const lines = await prisma.journalLine.findMany({
      where: { journalEntryId: entry.id },
      select: { accountId: true, credit: true },
    });

    expect(lines).toHaveLength(4);
    const cgst = lines.find(
      (line) => line.accountId === accountId(SYSTEM_ACCOUNT.GST_OUTPUT_CGST),
    );
    expect(cgst?.credit.toString()).toBe("450");
  });

  it("refuses to post an unbalanced entry before it reaches the database", async () => {
    await expect(
      postJournalEntry(prisma, {
        companyId,
        entryDate: ENTRY_DATE,
        voucherType: VoucherType.JOURNAL,
        lines: [
          { accountId: accountId(SYSTEM_ACCOUNT.CASH), debit: 100 },
          { accountId: accountId(SYSTEM_ACCOUNT.SALES), credit: 99 },
        ],
      }),
    ).rejects.toThrow(/not balanced/i);
  });

  it("refuses to post to a date outside any fiscal period", async () => {
    // The calendar opens a year that time has moved into, so a date it refuses
    // is one no year should exist for — here, years before the business did.
    await expect(
      postJournalEntry(prisma, {
        companyId,
        entryDate: new Date("2019-01-01T00:00:00.000Z"),
        voucherType: VoucherType.JOURNAL,
        lines: [
          { accountId: accountId(SYSTEM_ACCOUNT.CASH), debit: 100 },
          { accountId: accountId(SYSTEM_ACCOUNT.SALES), credit: 100 },
        ],
      }),
    ).rejects.toThrow(/before this business's first fiscal year/i);
  });

  it("refuses to post into a closed period", async () => {
    await prisma.fiscalPeriod.update({
      where: { id: fiscalPeriodId },
      data: { status: "CLOSED" },
    });

    try {
      await expect(
        postJournalEntry(prisma, {
          companyId,
          entryDate: ENTRY_DATE,
          voucherType: VoucherType.JOURNAL,
          lines: [
            { accountId: accountId(SYSTEM_ACCOUNT.CASH), debit: 100 },
            { accountId: accountId(SYSTEM_ACCOUNT.SALES), credit: 100 },
          ],
        }),
      ).rejects.toThrow(/period.*is closed/i);
    } finally {
      await prisma.fiscalPeriod.update({
        where: { id: fiscalPeriodId },
        data: { status: "OPEN" },
      });
    }
  });
});

describe("trial balance", () => {
  it("balances across every posted line in the company", async () => {
    const [totals] = await prisma.$queryRaw<
      Array<{ debit: string | null; credit: string | null }>
    >`
      SELECT SUM("debit")::text AS debit, SUM("credit")::text AS credit
        FROM "journal_lines"
       WHERE "companyId" = ${companyId}::uuid
         AND "status" = 'POSTED'
    `;

    expect(totals?.debit).toBe(totals?.credit);
  });
});
