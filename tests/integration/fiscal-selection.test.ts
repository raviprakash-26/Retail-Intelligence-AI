import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RegisterInput } from "@/lib/validation/auth";
import { registerOwner } from "@/server/auth/registration";
import { provisionCompany } from "@/server/provisioning/company-provisioner";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * Which year a page works in.
 *
 * The header's selector writes a cookie; `selectedFiscalYear` is the one place
 * that reads it. What matters is the order of precedence — a link's own year
 * beats the cookie, the cookie beats whichever year happens to be current — and
 * that a cookie is treated as what it is: client data, which may name a year
 * belonging to somebody else entirely.
 */

/** Whatever the cookie holds for the case being run. */
let cookieValue: string | undefined;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "riai_fy" && cookieValue
        ? { name, value: cookieValue }
        : undefined,
  }),
}));

const { selectedFiscalYear } = await import("@/server/fiscal/fiscal-service");

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
      businessName: `Selection ${uniqueSlug("Mart")}`,
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

/** A company with a past year and a current one, the way time produces them. */
async function companyWithTwoYears(): Promise<{
  companyId: string;
  currentYearId: string;
  earlierYearId: string;
}> {
  const email = `sel-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const owner = await registerOwner(registrationInput(email));
  createdCompanies.push(owner.companyId);

  const now = new Date();
  const provisioned = await prisma.$transaction((tx) =>
    provisionCompany(tx, {
      name: "Two Year Mart",
      slug: uniqueSlug("twoyear"),
      stateCode: "29",
      fiscalYearStartMonth: 4,
      asOf: new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 13, 15),
      ),
    }),
  );
  createdCompanies.push(provisioned.companyId);

  // The second year, opened the way trading opens it.
  const { ensureFiscalYearFor } =
    await import("@/server/fiscal/fiscal-calendar");
  await prisma.$transaction((tx) =>
    ensureFiscalYearFor(tx, { companyId: provisioned.companyId, date: now }),
  );

  const years = await prisma.fiscalYear.findMany({
    where: { companyId: provisioned.companyId },
    select: { id: true, isCurrent: true },
    orderBy: { startDate: "asc" },
  });
  expect(years).toHaveLength(2);

  return {
    companyId: provisioned.companyId,
    earlierYearId: years[0]!.id,
    currentYearId: years[1]!.id,
  };
}

beforeAll(async () => {
  await ensurePlatformData();
}, 60_000);

afterAll(async () => {
  for (const id of createdCompanies) await purgeTestCompany(id);
  await purgeTestUsers(createdEmails);
  await disconnectTestDb();
});

describe("the year a page works in", () => {
  it("is the one the cookie names, not whichever is current", async () => {
    const shop = await companyWithTwoYears();

    cookieValue = shop.earlierYearId;
    const chosen = await selectedFiscalYear(shop.companyId);

    // The defect this replaced: the current year regardless, while the header
    // above the page said otherwise.
    expect(chosen?.id).toBe(shop.earlierYearId);
    expect(chosen?.isCurrent).toBe(false);
  }, 60_000);

  it("falls back to the current year when nothing is chosen", async () => {
    const shop = await companyWithTwoYears();

    cookieValue = undefined;
    const chosen = await selectedFiscalYear(shop.companyId);

    expect(chosen?.id).toBe(shop.currentYearId);
    expect(chosen?.isCurrent).toBe(true);
  }, 60_000);

  it("lets a link's own year win over the cookie", async () => {
    const shop = await companyWithTwoYears();

    cookieValue = shop.currentYearId;
    const chosen = await selectedFiscalYear(shop.companyId, shop.earlierYearId);

    expect(chosen?.id).toBe(shop.earlierYearId);
  }, 60_000);

  it("ignores a year belonging to another business", async () => {
    const [mine, theirs] = await Promise.all([
      companyWithTwoYears(),
      companyWithTwoYears(),
    ]);

    // A cookie is client data. Naming another tenant's year must resolve to
    // nothing of theirs — the fallback is my own current year, not their books.
    cookieValue = theirs.earlierYearId;
    const chosen = await selectedFiscalYear(mine.companyId);

    expect(chosen?.id).toBe(mine.currentYearId);
    expect(chosen?.id).not.toBe(theirs.earlierYearId);
  }, 90_000);
});
