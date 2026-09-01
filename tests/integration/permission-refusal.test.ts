import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RegisterInput } from "@/lib/validation/auth";
import type { PermissionKey } from "@/lib/rbac/permissions";
import { registerOwner } from "@/server/auth/registration";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * What a member without a permission actually gets.
 *
 * `assertPermission` is the gate every server action opens with, and its own
 * comment said what was supposed to happen: "Actions return a result object
 * rather than throwing a navigation signal, so this throws a plain error the
 * action can convert into a form-level message."
 *
 * No action converted it. Every one of the ninety-two calls `assertPermission`
 * as its first or second statement, outside the `try` that wraps the service
 * call, so `PermissionDeniedError` left the action as a rejected promise. The
 * client side is written for the contract the comment describes — the
 * reconciliation page's helper is `try { const result = await work(); if
 * (!result.ok) setError(...) } finally { setBusy(null) }`, with no `catch` —
 * so the rejection went nowhere at all. The spinner stopped and nothing else
 * happened. Not a wrong message: no message.
 *
 * The same file already knew the answer. `requirePermission`, which pages use
 * for the identical question, calls `forbidden()`, and `assertPermission`'s own
 * first branch calls `unauthorized()` for a missing session — a navigation
 * signal, in the function whose comment says it avoids them. The app ships
 * `forbidden.tsx` and `unauthorized.tsx` and turns `authInterrupts` on to serve
 * them. Only the permission branch went its own way.
 *
 * This drives the real gate: a real session, a real membership, a real role
 * that genuinely lacks the permission being asked for. Nothing is stubbed but
 * the cookie jar.
 *
 * What it pins is that the two gates now refuse the same way. It cannot pin
 * the rendering: `forbidden()` reads `experimental.authInterrupts` from
 * `next.config`, which the test runner does not load, so under vitest it
 * raises a configuration error rather than the navigation signal it raises in
 * the app. Both gates raise the identical thing either way, which is the part
 * that was wrong and the part worth holding here — `requirePermission` was
 * always right, and every page-level refusal in the app already goes through
 * it, so the mechanism itself is not in doubt. What was in doubt was whether
 * actions used it.
 */

const prisma = testDb();
const createdCompanies: string[] = [];
const createdEmails: string[] = [];

/** The session cookie for the case being run. */
let cookieValue: string | undefined;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "riai_session" && cookieValue
        ? { name, value: cookieValue }
        : undefined,
    set: () => undefined,
  }),
}));

const { assertPermission, requirePermission, getCompanyContext } =
  await import("@/server/auth/context");
const { createSession } = await import("@/server/auth/session");

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
      businessName: `Gate ${uniqueSlug("Mart")}`,
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

/**
 * A signed-in member of a company, holding exactly the permissions given.
 *
 * The owner's role is replaced with a custom one rather than a new user being
 * invited: what matters is the permission set behind the session, and building
 * it directly keeps the case readable.
 */
async function signedInWith(
  granted: readonly PermissionKey[],
): Promise<{ companyId: string }> {
  const email = `gate-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const result = await registerOwner(registrationInput(email));
  createdCompanies.push(result.companyId);

  const role = await prisma.role.create({
    data: {
      companyId: result.companyId,
      key: `custom-${uniqueSlug("r")}`,
      name: "Reconciler",
      isSystem: false,
      permissions: {
        createMany: {
          data: (
            await prisma.permission.findMany({
              where: { key: { in: [...granted] } },
              select: { id: true },
            })
          ).map((permission) => ({ permissionId: permission.id })),
        },
      },
    },
    select: { id: true },
  });

  await prisma.membership.updateMany({
    where: { companyId: result.companyId, userId: result.userId },
    data: { roleId: role.id },
  });

  const session = await createSession({
    userId: result.userId,
    companyId: result.companyId,
  });
  cookieValue = session.token;

  return { companyId: result.companyId };
}

beforeAll(async () => {
  await ensurePlatformData();
});

afterAll(async () => {
  cookieValue = undefined;
  for (const companyId of createdCompanies) await purgeTestCompany(companyId);
  await purgeTestUsers(createdEmails);
  await disconnectTestDb();
});

/** Whatever a call refused with, or null if it did not refuse. */
async function refusalFrom(work: () => Promise<unknown>): Promise<unknown> {
  return work().then(
    () => null,
    (error: unknown) => error,
  );
}

const constructorOf = (error: unknown): string =>
  (error as { constructor?: { name?: string } })?.constructor?.name ?? "none";

const messageOf = (error: unknown): string =>
  (error as { message?: string })?.message ?? "";

describe("a member without the permission", () => {
  it("is recognised, and is genuinely missing it", async () => {
    // The fixture has to be real for the rest to mean anything: a session that
    // resolves, a membership that authorises it, and a role that holds one
    // permission and not the other.
    await signedInWith(["banking.view", "banking.reconcile"]);

    const context = await getCompanyContext();
    expect(context).not.toBeNull();
    expect(context?.permissions.has("banking.reconcile")).toBe(true);
    expect(context?.permissions.has("accounting.journal.create")).toBe(false);
  }, 90_000);

  it("passes the gate for what it holds", async () => {
    await signedInWith(["banking.view", "banking.reconcile"]);
    const context = await assertPermission("banking.reconcile");
    expect(context.permissions.has("banking.reconcile")).toBe(true);
  }, 90_000);

  it("is refused the same way a page refuses it", async () => {
    await signedInWith(["banking.view", "banking.reconcile"]);

    const refusedByAction = await refusalFrom(() =>
      assertPermission("accounting.journal.create"),
    );
    const refusedByPage = await refusalFrom(() =>
      requirePermission("accounting.journal.create"),
    );

    // Both refuse, and with the same thing. `requirePermission` was always
    // right; the action gate was the one that invented its own error, and an
    // error only it raised was an error only it could have handled — which
    // nothing did.
    expect(refusedByAction).not.toBeNull();
    expect(refusedByPage).not.toBeNull();
    expect(constructorOf(refusedByAction)).toBe(constructorOf(refusedByPage));
    expect(messageOf(refusedByAction)).toBe(messageOf(refusedByPage));
  }, 90_000);
});
