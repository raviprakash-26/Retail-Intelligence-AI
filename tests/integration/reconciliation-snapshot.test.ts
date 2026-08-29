import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GstDirection, StockMovementType, VoucherType } from "@prisma/client";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import type { RegisterInput } from "@/lib/validation/auth";
import type { ProductInput } from "@/lib/validation/master-data";
import { registerOwner } from "@/server/auth/registration";
import { postJournalEntry } from "@/server/accounting/post-journal-entry";
import { reconcileStock } from "@/server/inventory/inventory-report";
import { writeGstRows } from "@/server/documents/gst-register";
import { getGstWorkingPaper } from "@/server/gst/gst-return-service";
import { recordOutward } from "@/server/inventory/stock-service";
import { money } from "@/lib/money";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * The three figures the reconciliation compares are read as one.
 *
 * `reconcileStock` asks whether the cached position on each product, the sum of
 * its movements, and the Inventory account in the general ledger agree. They are
 * written by three different parts of the system, which is what makes the
 * question worth asking, and they are compared with no tolerance — a difference
 * means stock moved without the accounting following it, and the auditor writes
 * it down as a HIGH finding titled "Stock on the shelves and stock in the books
 * disagree".
 *
 * It read them in five separate statements outside any transaction, so each one
 * saw the database as it stood at that instant. Every posting path writes all
 * three inside one transaction, so the *books* are never inconsistent; the
 * reconciliation could see them so anyway, by reading the balances before a sale
 * committed and the ledger after. The sale is then in one figure and not the
 * other, and the difference reported is the cost of goods on an invoice that was
 * posted correctly.
 *
 * That is not a report a shopkeeper can dismiss. The auditor stores its findings
 * — `auditFinding.createMany`, status OPEN — so a sweep run while the shop is
 * trading leaves a HIGH accusation on the record until the next one, about a
 * disagreement that never existed and cannot be found afterwards. The module's
 * own opening says what is wrong with that: "a finding nobody can verify is an
 * accusation, and this module is built not to make those."
 *
 * The case below holds a posting open, lets the reconciliation get past the
 * balances, then commits it before the ledger read — the exact interleaving,
 * made to happen rather than waited for.
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
      businessName: "Snapshot Mart",
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
      openingCashBalance: 0,
      openingBankBalance: 0,
      inventoryMethod: "WEIGHTED_AVERAGE",
      loadDemoData: false,
    },
  };
}

type Fixture = {
  companyId: string;
  userId: string;
  productId: string;
  /** Opening stock is placed on the primary branch, and a position is looked
   * up on its branch exactly — so this is where the goods actually are. */
  branchId: string | null;
};

async function shopHoldingStock(): Promise<Fixture> {
  const email = `snap-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const owner = await registerOwner(registrationInput(email));
  createdCompanies.push(owner.companyId);

  const taxonomy = await getProductTaxonomy(owner.companyId);
  const unit = taxonomy.units.find((entry) => entry.code === "PCS");
  if (!unit) throw new Error("Provisioning is incomplete");

  const product = await createProduct({
    companyId: owner.companyId,
    userId: owner.userId,
    actorEmail: "owner@example.com",
    input: {
      sku: "WIDGET",
      name: "Widget",
      description: "",
      barcode: "",
      hsnCode: "1006",
      categoryId: "",
      unitId: unit.id,
      taxRateId: "",
      purchasePrice: 60,
      sellingPrice: 250,
      mrp: 0,
      isStockTracked: true,
      openingQuantity: 500,
      openingRate: 60,
      minStockLevel: 0,
    } satisfies ProductInput,
  });

  const primary = await prisma.branch.findFirst({
    where: { companyId: owner.companyId, isPrimary: true },
    select: { id: true },
  });

  return {
    companyId: owner.companyId,
    userId: owner.userId,
    productId: product.id,
    branchId: primary?.id ?? null,
  };
}

/** How many sessions are queued for `journal_lines` and cannot have it yet. */
async function waitingOnLedger(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ waiting: number }>>`
    SELECT count(*)::int AS waiting
      FROM pg_locks
     WHERE locktype = 'relation'
       AND relation = 'journal_lines'::regclass
       AND NOT granted
  `;
  return rows[0]?.waiting ?? 0;
}

async function until(what: string, ready: () => Promise<boolean>) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

/** Ends a gate transaction without leaving anything behind. */
class ReleaseGate extends Error {}

beforeAll(async () => {
  await ensurePlatformData();
}, 60_000);

afterAll(async () => {
  for (const id of createdCompanies) {
    await purgeTestCompany(id).catch(() => undefined);
  }
  await purgeTestUsers(createdEmails);
  await disconnectTestDb();
});

describe("the stock reconciliation", () => {
  it("does not see a posting half-committed", async () => {
    const fixture = await shopHoldingStock();

    const accounts = await prisma.account.findMany({
      where: {
        companyId: fixture.companyId,
        systemKey: {
          in: [SYSTEM_ACCOUNT.INVENTORY, SYSTEM_ACCOUNT.DIRECT_EXPENSES],
        },
      },
      select: { id: true, systemKey: true },
    });
    const accountId = (key: string) =>
      accounts.find((account) => account.systemKey === key)!.id;

    const before = await reconcileStock(fixture.companyId);
    expect(before.agrees).toBe(true);

    // --- A posting held open ------------------------------------------------
    //
    // Written through the same two funnels a stock write-off uses, so what is
    // in flight is a real movement and a real entry rather than rows put there
    // by the test. It moves the shelf and the Inventory account by the same
    // ₹600, which is what makes a reader that sees one and not the other wrong
    // by exactly that.
    let openWriter!: () => void;
    let commitWriter!: () => void;
    const writerReady = new Promise<void>((resolve) => {
      openWriter = resolve;
    });
    const writerHeld = new Promise<void>((resolve) => {
      commitWriter = resolve;
    });

    const writer = prisma.$transaction(
      async (tx) => {
        const movement = await recordOutward(tx, {
          companyId: fixture.companyId,
          productId: fixture.productId,
          branchId: fixture.branchId,
          method: "WEIGHTED_AVERAGE",
          quantity: 10,
          movementType: StockMovementType.WRITE_OFF,
          movementDate: new Date(),
          sourceType: "SNAPSHOT_TEST",
          sourceId: fixture.productId,
          createdById: fixture.userId,
        });

        await postJournalEntry(tx, {
          companyId: fixture.companyId,
          entryDate: new Date(),
          voucherType: VoucherType.JOURNAL,
          isSystem: true,
          createdById: fixture.userId,
          lines: [
            {
              accountId: accountId(SYSTEM_ACCOUNT.DIRECT_EXPENSES),
              debit: movement.value,
            },
            {
              accountId: accountId(SYSTEM_ACCOUNT.INVENTORY),
              credit: movement.value,
            },
          ],
        });

        openWriter();
        await writerHeld;
      },
      { timeout: 60_000, maxWait: 30_000 },
    );

    await writerReady;

    // --- A gate the ledger read has to queue behind -------------------------
    //
    // The writer already holds `journal_lines` for its own insert, so this
    // waits; and once it is waiting, every later reader of that table queues
    // behind it. That is the lever: the reconciliation gets through the
    // balances and the movements untouched and stops at the ledger, which is
    // the one read that has to land on the far side of the commit.
    let releaseGate!: () => void;
    const gateReleased = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const gate = prisma
      .$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            "LOCK TABLE journal_lines IN ACCESS EXCLUSIVE MODE",
          );
          await gateReleased;
          throw new ReleaseGate();
        },
        { timeout: 60_000, maxWait: 30_000 },
      )
      .catch((error: unknown) => {
        if (!(error instanceof ReleaseGate)) throw error;
      });

    await until("the gate to queue for the ledger", async () => {
      return (await waitingOnLedger()) >= 1;
    });

    const reconciliation = reconcileStock(fixture.companyId);

    await until("the reconciliation to reach the ledger", async () => {
      return (await waitingOnLedger()) >= 2;
    });

    // The posting lands now — after the balances were read and before the
    // ledger is.
    commitWriter();
    await writer;
    releaseGate();
    await gate;

    const after = await reconciliation;

    // Whatever it saw, it saw one database. Reading the balances before the
    // write-off and the ledger after put ₹600 of stock in one figure and not
    // the other, and reported a shop whose books had never disagreed.
    expect(after.accountDifference).toBe("0.0000");
    expect(after.cacheDifference).toBe("0.0000");
    expect(after.agrees).toBe(true);

    // And it is a real posting, visible to the next reader.
    const settled = await reconcileStock(fixture.companyId);
    expect(settled.agrees).toBe(true);
    expect(settled.ledgerValue).not.toBe(before.ledgerValue);
  }, 120_000);
});

describe("the GST working paper", () => {
  it("does not see a document half-committed either", async () => {
    // The same shape in the other module that puts two records side by side and
    // reports at HIGH when they disagree: tax computed from the register against
    // the movement on the GST accounts.
    const fixture = await shopHoldingStock();
    const now = new Date();
    const period = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };

    const gst = await prisma.account.findMany({
      where: {
        companyId: fixture.companyId,
        systemKey: {
          in: [SYSTEM_ACCOUNT.GST_OUTPUT_CGST, SYSTEM_ACCOUNT.GST_OUTPUT_SGST],
        },
      },
      select: { id: true, systemKey: true },
    });
    const gstAccount = (key: string) =>
      gst.find((account) => account.systemKey === key)!.id;
    const cash = await prisma.account.findFirstOrThrow({
      where: { companyId: fixture.companyId, systemKey: SYSTEM_ACCOUNT.CASH },
      select: { id: true },
    });

    const before = await getGstWorkingPaper({
      companyId: fixture.companyId,
      ...period,
    });
    expect(before.reconciliation.agrees).toBe(true);

    let openWriter!: () => void;
    let commitWriter!: () => void;
    const writerReady = new Promise<void>((resolve) => {
      openWriter = resolve;
    });
    const writerHeld = new Promise<void>((resolve) => {
      commitWriter = resolve;
    });

    const writer = prisma.$transaction(
      async (tx) => {
        // Both records, through the funnels the document services use: the
        // register row and the entry that has to agree with it.
        await writeGstRows(tx, {
          companyId: fixture.companyId,
          direction: GstDirection.OUTWARD,
          documentType: "SALE",
          documentId: fixture.productId,
          documentNumber: "SNAP-1",
          documentDate: now,
          supplyType: "INTRA_STATE",
          placeOfSupply: "29",
          partyName: "Counter",
          partyGstin: null,
          lines: [
            {
              grossAmount: money(1000),
              discountAmount: money(0),
              taxableAmount: money(1000),
              taxPercent: money(18),
              cgstAmount: money(90),
              sgstAmount: money(90),
              igstAmount: money(0),
              cessAmount: money(0),
              lineTotal: money(1180),
              hsnCode: "1006",
              taxRateId: null,
            },
          ],
          sign: 1,
        });

        await postJournalEntry(tx, {
          companyId: fixture.companyId,
          entryDate: now,
          voucherType: VoucherType.SALES,
          isSystem: true,
          createdById: fixture.userId,
          // Matching the register row exactly: the two halves of an
          // intra-state supply, ₹90 each.
          lines: [
            { accountId: cash.id, debit: 180 },
            {
              accountId: gstAccount(SYSTEM_ACCOUNT.GST_OUTPUT_CGST),
              credit: 90,
            },
            {
              accountId: gstAccount(SYSTEM_ACCOUNT.GST_OUTPUT_SGST),
              credit: 90,
            },
          ],
        });

        openWriter();
        await writerHeld;
      },
      { timeout: 60_000, maxWait: 30_000 },
    );

    await writerReady;

    let releaseGate!: () => void;
    const gateReleased = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const gate = prisma
      .$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            "LOCK TABLE journal_lines IN ACCESS EXCLUSIVE MODE",
          );
          await gateReleased;
          throw new ReleaseGate();
        },
        { timeout: 60_000, maxWait: 30_000 },
      )
      .catch((error: unknown) => {
        if (!(error instanceof ReleaseGate)) throw error;
      });

    await until("the gate to queue for the ledger", async () => {
      return (await waitingOnLedger()) >= 1;
    });

    // The register is read first and the GST accounts last, so this stops
    // between them.
    const paper = getGstWorkingPaper({
      companyId: fixture.companyId,
      ...period,
    });

    await until("the paper to reach the ledger", async () => {
      return (await waitingOnLedger()) >= 2;
    });

    commitWriter();
    await writer;
    releaseGate();
    await gate;

    const after = await paper;

    // Either both figures carry the ₹180 or neither does. Splitting them put it
    // in the ledger alone and accused the register of being short by it.
    expect(after.reconciliation.agrees).toBe(true);

    const settled = await getGstWorkingPaper({
      companyId: fixture.companyId,
      ...period,
    });
    expect(settled.reconciliation.agrees).toBe(true);
  }, 120_000);
});
