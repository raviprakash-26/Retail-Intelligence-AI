import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PermissionKey } from "@/lib/rbac/permissions";
import type { RegisterInput } from "@/lib/validation/auth";
import type { CustomerInput } from "@/lib/validation/master-data";
import { ACTION_ERROR } from "@/server/auth/action-result";
import { registerOwner } from "@/server/auth/registration";
import { createParty } from "@/server/master-data/party-service";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * Editing a customer's opening balance is posting.
 *
 * It does not look like it. `updateParty` mostly writes a phone number and a
 * billing address, and the ledger branch inside it fires only when the opening
 * position actually moves — but when it does it posts an "Opening balance
 * correction" through `postOpeningDelta`, which is the same function
 * `createParty` uses for the original entry.
 *
 * `createPartyAction` asked billing before it did that. `updatePartyAction` did
 * not, so one journal entry had two routes into the books and a business whose
 * subscription had lapsed could take the second one. Correcting an opening
 * balance is not a small entry either: it moves the control account, and it is
 * the figure every ageing report and every reconciliation is measured from.
 *
 * Only the auth boundary is stubbed; the action is the real one.
 */

const prisma = testDb();
const createdCompanies: string[] = [];
const createdEmails: string[] = [];

let permissions = new Set<PermissionKey>();
let actor = { companyId: "", userId: "", email: "" };

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

vi.mock("@/server/security/request-context", () => ({
  requireSameOrigin: async () => undefined,
}));

vi.mock("@/server/auth/context", () => ({
  assertPermission: async () => ({
    company: { id: actor.companyId },
    user: { id: actor.userId, email: actor.email },
    permissions,
  }),
}));

const { updatePartyAction } = await import("@/server/master-data/actions");

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
      businessName: `Opening ${uniqueSlug("Mart")}`,
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
      openingBankBalance: 0,
      inventoryMethod: "WEIGHTED_AVERAGE",
      loadDemoData: false,
    },
  };
}

function customerInput(over: Partial<CustomerInput> = {}): CustomerInput {
  return {
    name: "Lakshmi Stores",
    phone: "9845000001",
    email: "",
    gstin: "",
    pan: "",
    addressLine1: "12 Market Road",
    notes: "",
    city: "Bengaluru",
    stateCode: "29",
    pincode: "560002",
    creditLimit: 0,
    creditDays: 0,
    openingBalance: 5000,
    openingNature: "DEBIT",
    ...over,
  };
}

/** A shop with one customer carrying a ₹5,000 opening balance. */
async function shopWithCustomer(): Promise<{ partyId: string }> {
  const email = `opening-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const result = await registerOwner(registrationInput(email));
  createdCompanies.push(result.companyId);
  actor = { companyId: result.companyId, userId: result.userId, email };

  const party = await createParty({
    companyId: result.companyId,
    kind: "CUSTOMER",
    userId: result.userId,
    actorEmail: email,
    input: customerInput(),
  });

  return { partyId: party.id };
}

/** Every posted entry this company holds, for counting new ones. */
async function entryCount(companyId: string): Promise<number> {
  return prisma.journalEntry.count({ where: { companyId } });
}

beforeAll(async () => {
  await ensurePlatformData();
});

afterAll(async () => {
  for (const companyId of createdCompanies) await purgeTestCompany(companyId);
  await purgeTestUsers(createdEmails);
  await disconnectTestDb();
});

describe("correcting an opening balance on a lapsed subscription", () => {
  it("posts no correction for a business with no plan", async () => {
    const { partyId } = await shopWithCustomer();
    permissions = new Set<PermissionKey>([
      "customers.view",
      "customers.manage",
    ]);
    const before = await entryCount(actor.companyId);
    await prisma.subscription.deleteMany({
      where: { companyId: actor.companyId },
    });

    const result = await updatePartyAction(
      "CUSTOMER",
      partyId,
      customerInput({ openingBalance: 9000 }),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe(
      ACTION_ERROR.SUBSCRIPTION_READ_ONLY,
    );
    expect(await entryCount(actor.companyId)).toBe(before);

    // And the balance on the row is untouched, so nothing was half done.
    const customer = await prisma.customer.findFirstOrThrow({
      where: { id: partyId },
      select: { openingBalance: true },
    });
    expect(customer.openingBalance.toString()).toBe("5000");
  }, 90_000);

  it("goes through, and posts the correction, on a live one", async () => {
    const { partyId } = await shopWithCustomer();
    permissions = new Set<PermissionKey>([
      "customers.view",
      "customers.manage",
    ]);
    const before = await entryCount(actor.companyId);

    const result = await updatePartyAction(
      "CUSTOMER",
      partyId,
      customerInput({ openingBalance: 9000 }),
    );

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.data.openingEntry).not.toBeNull();
    // One correction entry, for the ₹4,000 the position moved by.
    expect(await entryCount(actor.companyId)).toBe(before + 1);
  }, 90_000);

  it("refuses the edit that posts nothing too, and says which gate closed", async () => {
    // Changing a phone number never reaches the ledger, so a guard on the
    // whole action refuses more than the ledger strictly needs. That is the
    // same trade `unmatchTransactionAction` makes and worth pinning rather
    // than discovering: the rule is "an action that can post asks first", and
    // an action cannot know which it is until it has read the party.
    const { partyId } = await shopWithCustomer();
    permissions = new Set<PermissionKey>([
      "customers.view",
      "customers.manage",
    ]);
    await prisma.subscription.deleteMany({
      where: { companyId: actor.companyId },
    });

    const result = await updatePartyAction(
      "CUSTOMER",
      partyId,
      customerInput({ phone: "9845099999" }),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe(
      ACTION_ERROR.SUBSCRIPTION_READ_ONLY,
    );
  }, 90_000);
});
