import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RegisterInput } from "@/lib/validation/auth";
import type { StockAdjustmentInput } from "@/lib/validation/inventory";
import type { CustomerInput, ProductInput } from "@/lib/validation/master-data";
import type { SaleInput } from "@/lib/validation/sales";
import { registerOwner } from "@/server/auth/registration";
import { ensureFiscalYearFor } from "@/server/fiscal/fiscal-calendar";
import { createStockAdjustment } from "@/server/inventory/adjustment-service";
import { createParty } from "@/server/master-data/party-service";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";
import { provisionCompany } from "@/server/provisioning/company-provisioner";
import { createSale } from "@/server/sales/sale-service";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * The order two transactions take the same pair of locks in.
 *
 * The application holds two advisory locks, both per company and both held to
 * commit. `lockStock` freezes a company's stock positions while a movement is
 * worked out; `ensureFiscalYearFor` serialises opening a fiscal year the
 * calendar has not reached yet. Neither is contended often — one is taken on
 * every stock movement, the other once a year per tenant — and for a long time
 * no two paths took both in the same order.
 *
 * A sale settles the calendar first: it needs a fiscal year to hang the invoice
 * number off, so `ensureFiscalYearFor` runs before `allocateDocumentNumber` and
 * long before the stock lock. A stock adjustment takes no document number at
 * all, so nothing made it think about the calendar — it took the stock lock,
 * worked the movement out, and met the calendar on the way into
 * `postJournalEntry`, which settles the year itself.
 *
 * Stock then calendar against calendar then stock is a cycle, and the cycle is
 * a deadlock: Postgres picks one of the two transactions and aborts it. The
 * shopkeeper gets a raw `deadlock detected` where they expected an invoice.
 *
 * What makes it worth a test rather than a note is when it happens. The
 * calendar lock is only taken when a year is actually missing — the first
 * posting on the first morning of a new fiscal year, which is exactly the
 * moment `fiscal-calendar` describes when it explains why the lock exists at
 * all ("two tills selling at nine on the first of April"). The lock written to
 * make that morning safe is the one that made it unsafe for anybody counting
 * stock at the same time.
 *
 * `lockStock` said so in as many words — that its order was the one order and
 * "nothing here can deadlock against anything else" — and the claim was true
 * of every lock it had thought about.
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
      businessName: `Locks ${uniqueSlug("Mart")}`,
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
      openingCashBalance: 20000,
      openingBankBalance: 0,
      inventoryMethod: "WEIGHTED_AVERAGE",
      loadDemoData: false,
    },
  };
}

type Fixture = {
  companyId: string;
  userId: string;
  customerId: string;
  productId: string;
};

/**
 * A shop whose calendar has run out.
 *
 * Provisioned thirteen months back rather than registered, because
 * registration always signs a company up today and the whole question here is
 * what the first posting of a new fiscal year does.
 */
async function shopWithNoYearForToday(): Promise<Fixture> {
  const email = `lock-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const owner = await registerOwner(registrationInput(email));
  createdCompanies.push(owner.companyId);

  const now = new Date();
  const provisioned = await prisma.$transaction((tx) =>
    provisionCompany(tx, {
      name: "Older Mart",
      slug: uniqueSlug("locks"),
      stateCode: "29",
      fiscalYearStartMonth: 4,
      asOf: new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 13, 15),
      ),
    }),
  );
  createdCompanies.push(provisioned.companyId);

  const base = {
    companyId: provisioned.companyId,
    userId: owner.userId,
    actorEmail: "owner@example.com",
  };

  const taxonomy = await getProductTaxonomy(provisioned.companyId);
  const unit = taxonomy.units.find((entry) => entry.code === "PCS");
  if (!unit) throw new Error("Provisioning is incomplete");

  const product = await createProduct({
    ...base,
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

  const customer = await createParty({
    ...base,
    kind: "CUSTOMER",
    input: {
      name: "Sharma Provision Store",
      phone: "",
      email: "",
      gstin: "",
      pan: "",
      addressLine1: "",
      city: "",
      stateCode: "29",
      pincode: "",
      creditDays: 30,
      creditLimit: 0,
      openingBalance: 0,
      openingNature: "DEBIT",
      notes: "",
    } satisfies CustomerInput,
  });

  return {
    companyId: provisioned.companyId,
    userId: owner.userId,
    customerId: customer.id,
    productId: product.id,
  };
}

function sell(fixture: Fixture, on: Date) {
  return createSale({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: "owner@example.com",
    branchId: null,
    input: {
      customerId: fixture.customerId,
      invoiceDate: on.toISOString().slice(0, 10),
      paymentMode: "CASH",
      placeOfSupply: "",
      priceIncludesTax: false,
      notes: "",
      lines: [
        {
          productId: fixture.productId,
          description: "",
          quantity: 1,
          rate: 250,
          discountPercent: 0,
        },
      ],
    } satisfies SaleInput,
  });
}

function countStock(fixture: Fixture, on: Date, counted: number) {
  return createStockAdjustment({
    companyId: fixture.companyId,
    branchId: null,
    userId: fixture.userId,
    actorEmail: "owner@example.com",
    input: {
      productId: fixture.productId,
      adjustmentDate: on.toISOString().slice(0, 10),
      reason: "COUNT",
      countedQuantity: counted,
      notes: "Counted the shelf this morning.",
    } satisfies StockAdjustmentInput,
  });
}

type LockRow = { kind: "stock" | "calendar"; granted: boolean };

/**
 * The two advisory locks this company holds or is queued for, from Postgres.
 *
 * Keyed by the company so a test file running beside this one cannot be
 * mistaken for a waiter here. `objsubid` tells the two apart: the stock lock is
 * taken with the single 8-byte key and reports 1, the calendar lock with the
 * pair of 4-byte keys and reports 2. The shifts and masks undo the way
 * `pg_locks` splits a key across two `oid` columns, which are unsigned where
 * the hashes are not.
 */
async function locksHeldFor(companyId: string): Promise<LockRow[]> {
  return prisma.$queryRaw<LockRow[]>`
    WITH key AS (SELECT hashtextextended(${`stock:${companyId}`}, 0) AS stock)
    SELECT CASE WHEN l.objsubid = 1 THEN 'stock' ELSE 'calendar' END AS kind,
           l.granted
      FROM pg_locks l, key
     WHERE l.locktype = 'advisory'
       AND (
             (l.objsubid = 1
                AND l.classid = ((key.stock >> 32) & 4294967295)::oid
                AND l.objid = (key.stock & 4294967295)::oid)
          OR (l.objsubid = 2
                AND l.objid = (hashtext(${companyId})::bigint & 4294967295)::oid)
       )
  `;
}

/** Polls until the database is in the state a step is waiting for. */
async function until(
  companyId: string,
  what: string,
  ready: (locks: LockRow[]) => boolean,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (ready(await locksHeldFor(companyId))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

/** Ends the gate transaction without leaving the year it opened behind. */
class ReleaseGate extends Error {}

beforeAll(async () => {
  await ensurePlatformData();
}, 60_000);

afterAll(async () => {
  for (const id of createdCompanies) await purgeTestCompany(id);
  await purgeTestUsers(createdEmails);
  await disconnectTestDb();
});

describe("the first postings of a new fiscal year", () => {
  it("do not deadlock when one of them is a stock count", async () => {
    const today = new Date();
    const fixture = await shopWithNoYearForToday();

    // --- A gate on the calendar lock ---------------------------------------
    //
    // Holding it through `ensureFiscalYearFor` rather than by reaching for the
    // lock's own key: the point is the lock the application takes, not one that
    // looks like it. The gate rolls back, so the year it opened goes with it
    // and whoever is next in the queue still finds the calendar short — which
    // is what puts two real callers inside the window at once.
    let openGate!: () => void;
    let releaseGate!: () => void;
    const gateHeld = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const gateReleased = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const gate = prisma
      .$transaction(
        async (tx) => {
          await ensureFiscalYearFor(tx, {
            companyId: fixture.companyId,
            date: today,
          });
          openGate();
          await gateReleased;
          throw new ReleaseGate();
        },
        { timeout: 60_000, maxWait: 30_000 },
      )
      .catch((error: unknown) => {
        if (!(error instanceof ReleaseGate)) throw error;
      });

    await gateHeld;

    // --- The sale, which settles the calendar before anything else ---------
    const sale = sell(fixture, today);
    await until(
      fixture.companyId,
      "the sale to queue behind the calendar lock",
      (locks) => locks.filter((lock) => !lock.granted).length >= 1,
    );

    // --- The count, which reaches for stock first --------------------------
    const count = countStock(fixture, today, 480);
    await until(
      fixture.companyId,
      "the stock count to take a lock of its own",
      (locks) =>
        // Whichever lock it gets to first: with the calendar settled ahead of
        // the stock lock it queues behind the sale, and without that it holds
        // stock while it waits.
        locks.some((lock) => lock.kind === "stock" && lock.granted) ||
        locks.filter((lock) => !lock.granted).length >= 2,
    );

    releaseGate();
    await gate;

    // Both finish. Before the calendar was settled ahead of the stock lock the
    // sale woke up holding the year and wanting stock, the count was holding
    // stock and wanting the year, and Postgres aborted one of them.
    const [invoice, adjustment] = await Promise.all([sale, count]);

    expect(invoice.invoiceNumber).toMatch(/^INV-/);
    expect(adjustment.direction).toBe("out");

    // And the year they were both racing to open exists exactly once.
    const years = await prisma.fiscalYear.findMany({
      where: {
        companyId: fixture.companyId,
        startDate: { lte: today },
        endDate: { gte: today },
      },
      select: { id: true },
    });
    expect(years).toHaveLength(1);
  }, 120_000);
});
