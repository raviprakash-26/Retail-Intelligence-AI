import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemoCompany } from "../../prisma/seed/demo-company";
import { demoOpenedOn, seedDemoTrading } from "../../prisma/seed/demo-trading";
import { getTrialBalance } from "@/server/accounting/trial-balance-service";
import { receivablesAgeing } from "@/server/settlements/outstanding";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
} from "../helpers/test-db";
import { coversDay } from "../helpers/calendar";

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
const runDate = new Date();
let companyId = "";
let emails: string[] = [];

/**
 * Seeds the demo shop as the seed script does, for a given run date.
 *
 * One at a time: the demo's people have fixed addresses, so two demo tenants
 * cannot exist at once — which is also why both cases live in this one file
 * rather than racing each other from two.
 */
async function seedDemoAsOf(asOf: Date): Promise<void> {
  const demo = await seedDemoCompany(prisma, asOf, demoOpenedOn(asOf));
  companyId = demo.companyId;

  const members = await prisma.membership.findMany({
    where: { companyId },
    select: { user: { select: { email: true } } },
  });
  emails = members.map((member) => member.user.email);

  await seedDemoTrading(prisma, companyId, demo.ownerId, asOf);
}

async function purgeDemo(): Promise<void> {
  if (companyId) await purgeTestCompany(companyId).catch(() => undefined);
  await purgeTestUsers(emails);
  companyId = "";
  emails = [];
}

afterAll(async () => {
  await purgeDemo();
  await disconnectTestDb();
});

describe("the demo tenant has actually traded", () => {
  beforeAll(async () => {
    await ensurePlatformData();
    await seedDemoAsOf(runDate);
  }, 300_000);

  afterAll(purgeDemo);

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

  it("never dates an invoice in the future", async () => {
    // A shop trading tomorrow. The old name for this case claimed it kept
    // every invoice inside one fiscal year, which it never checked and which
    // is not true: ninety-six days of history crosses 1 April for a quarter of
    // the year.
    const future = await prisma.sale.count({
      where: { companyId, invoiceDate: { gt: runDate } },
    });
    expect(future).toBe(0);
  }, 120_000);

  it("is still inside its trial", async () => {
    // The demo shop's books open before its account does, so that its history
    // has a calendar to sit in. Anchoring the subscription to the same day was
    // the obvious way to do that and the wrong one: the trial then started
    // ninety-six days ago and had already ended, and the demo — whose whole job
    // is to show a working shop — refused to post anything with "The trial has
    // ended." Only the browser suite noticed.
    const subscription = await prisma.subscription.findFirstOrThrow({
      where: { companyId },
      select: { status: true, trialEndsAt: true },
    });

    expect(subscription.status).toBe("TRIALING");
    expect(subscription.trialEndsAt!.getTime()).toBeGreaterThan(
      runDate.getTime(),
    );
  }, 120_000);

  it("opens its books before the first thing it recorded", async () => {
    // The seed used to provision the company on the day it ran, so a run in
    // April gave a shop a calendar starting after its own earliest bill, and
    // the seed died partway through with `No document sequence "PURCHASE"
    // configured`. Every document has to fall inside a period the calendar
    // actually covers.
    const [firstSale, firstPurchase, periods] = await Promise.all([
      prisma.sale.findFirstOrThrow({
        where: { companyId },
        select: { invoiceDate: true },
        orderBy: { invoiceDate: "asc" },
      }),
      prisma.purchase.findFirstOrThrow({
        where: { companyId },
        select: { billDate: true },
        orderBy: { billDate: "asc" },
      }),
      prisma.fiscalPeriod.findMany({
        where: { companyId },
        select: { startDate: true, endDate: true },
      }),
    ]);

    const covered = (date: Date) =>
      periods.some((period) => coversDay(period, date));

    expect(covered(firstPurchase.billDate)).toBe(true);
    expect(covered(firstSale.invoiceDate)).toBe(true);
    expect(covered(runDate)).toBe(true);
  }, 120_000);
});

describe("a demo seeded just after the year turns", () => {
  /**
   * The case that was broken, and only for part of the year.
   *
   * The shop's history reaches back ninety-six days, so a seed run in April,
   * May or June starts before 1 April — in the fiscal year before the one the
   * company was provisioned in. Nothing could open that year, so the seed died
   * partway through: `No document sequence "PURCHASE" configured for company`,
   * which named the counter rather than the missing year.
   *
   * Pinned to a date in the past, so it stays a boundary crossing however long
   * from now this runs.
   */
  const justAfterYearEnd = new Date("2026-04-20T00:00:00.000Z");

  beforeAll(async () => {
    await ensurePlatformData();
    await seedDemoAsOf(justAfterYearEnd);
  }, 300_000);

  afterAll(purgeDemo);

  it("trades across the boundary on a calendar that reaches both sides", async () => {
    const years = await prisma.fiscalYear.findMany({
      where: { companyId },
      select: { label: true, startDate: true, endDate: true, isCurrent: true },
      orderBy: { startDate: "asc" },
    });
    expect(years.length).toBeGreaterThan(1);

    const periods = await prisma.fiscalPeriod.findMany({
      where: { companyId },
      select: { startDate: true, endDate: true },
    });
    const covered = (date: Date) =>
      periods.some((period) => coversDay(period, date));

    const sales = await prisma.sale.findMany({
      where: { companyId },
      select: { invoiceDate: true },
    });
    expect(sales.length).toBeGreaterThan(50);
    expect(sales.filter((sale) => !covered(sale.invoiceDate))).toEqual([]);

    // Both sides of 1 April are represented, which is the whole point.
    const opening = years[years.length - 1]!.startDate;
    expect(sales.some((sale) => sale.invoiceDate < opening)).toBe(true);
    expect(sales.some((sale) => sale.invoiceDate >= opening)).toBe(true);
  }, 120_000);

  it("keeps the books balanced across two fiscal years", async () => {
    const trial = await getTrialBalance({
      companyId,
      to: justAfterYearEnd.toISOString().slice(0, 10),
    });
    expect(trial.balanced).toBe(true);
  }, 120_000);
});
