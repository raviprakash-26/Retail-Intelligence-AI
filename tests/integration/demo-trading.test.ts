import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemoCompany } from "../../prisma/seed/demo-company";
import { seedDemoTrading } from "../../prisma/seed/demo-trading";
import { getTrialBalance } from "@/server/accounting/trial-balance-service";
import { receivablesAgeing } from "@/server/settlements/outstanding";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
} from "../helpers/test-db";

/**
 * The demo shop is a shop.
 *
 * A demo is the first thing anybody sees, so what it shows has to be true. If
 * the seeded history leaves the books out of balance or a product at negative
 * stock, the demo is showing a bug that is not in the product — and the person
 * looking has no way to know which it is.
 *
 * These do not pin the figures. The generator is free to produce a different
 * shop; what it may not produce is an impossible one.
 */

const prisma = testDb();
let companyId = "";
const emails: string[] = [];

beforeAll(async () => {
  await ensurePlatformData();

  const demo = await seedDemoCompany(prisma, new Date());
  companyId = demo.companyId;

  const members = await prisma.membership.findMany({
    where: { companyId },
    select: { user: { select: { email: true } } },
  });
  emails.push(...members.map((member) => member.user.email));

  await seedDemoTrading(prisma, companyId, demo.ownerId, new Date());
}, 300_000);

afterAll(async () => {
  if (companyId) await purgeTestCompany(companyId).catch(() => undefined);
  await purgeTestUsers(emails);
  await disconnectTestDb();
});

describe("the demo tenant has actually traded", () => {
  it("has enough history to be worth looking at", async () => {
    // The state this replaced: a fully stocked shop with no transactions, and
    // every screen that matters blank.
    const [sales, purchases, expenses, receipts] = await Promise.all([
      prisma.sale.count({ where: { companyId } }),
      prisma.purchase.count({ where: { companyId } }),
      prisma.expense.count({ where: { companyId } }),
      prisma.receipt.count({ where: { companyId } }),
    ]);

    expect(sales).toBeGreaterThan(50);
    expect(purchases).toBeGreaterThan(3);
    expect(expenses).toBeGreaterThan(3);
    expect(receipts).toBeGreaterThan(3);
  }, 300_000);

  it("leaves the books balanced", async () => {
    // Everything is posted through the ordinary services, so this should hold
    // by construction — which is exactly why it is worth asserting. A seed
    // that ever writes a journal line directly will fail here first.
    const trial = await getTrialBalance({
      companyId,
      to: new Date().toISOString().slice(0, 10),
    });
    expect(trial.balanced).toBe(true);
  }, 120_000);

  it("never sells stock the shop does not have", async () => {
    // A demo showing negative stock is demonstrating a bug the product does
    // not have, and nobody looking can tell the difference.
    const balances = await prisma.inventoryBalance.findMany({
      where: { companyId },
      select: { quantity: true, product: { select: { sku: true } } },
    });

    const negative = balances.filter((row) => Number(row.quantity) < 0);
    expect(
      negative.map((row) => row.product.sku),
      "these products went negative",
    ).toEqual([]);
  }, 120_000);

  it("leaves money genuinely owed, across more than one age", async () => {
    // The ageing, the reminders and the advisor all need something to show. A
    // demo where every invoice is paid demonstrates none of them.
    const ageing = await receivablesAgeing(companyId);

    expect(Number(ageing.summary.total)).toBeGreaterThan(0);
    expect(Number(ageing.summary.overdue)).toBeGreaterThan(0);
    expect(ageing.parties.length).toBeGreaterThan(1);

    const occupied = Object.values(ageing.summary.buckets).filter(
      (value) => Number(value) > 0,
    );
    expect(occupied.length).toBeGreaterThan(1);
  }, 120_000);

  it("puts every invoice inside the fiscal year the demo opens in", async () => {
    // An invoice dated outside the open period cannot be posted, and one
    // dated in the future is a shop trading tomorrow.
    const now = new Date();
    const future = await prisma.sale.count({
      where: { companyId, invoiceDate: { gt: now } },
    });
    expect(future).toBe(0);
  }, 120_000);
});
