import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RegisterInput } from "@/lib/validation/auth";
import { companyScopedModels } from "@/lib/export/manifest";
import { registerOwner } from "@/server/auth/registration";
import { purgeCompany } from "@/server/provisioning/purge-company";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * Erasing a tenant erases its activity log.
 *
 * `purgeCompany` says it "permanently erases a tenant and every record
 * belonging to it", and names a data-deletion request as the reason to reach
 * for it. It did not erase the audit log: `AuditLog.companyId` is
 * `onDelete: SetNull`, so deleting the company detached every row instead of
 * removing it.
 *
 * What was left is not metadata. Each row carries `actorEmail`, `ipAddress`,
 * `userAgent`, and a `metadata` payload holding the before and after of the
 * change — the personal data of the people who worked there, surviving the one
 * operation the product offers for getting rid of it. Detached rows also match
 * no company, so nothing tenant-scoped would ever list them again and no
 * ordinary cleanup would ever reach them.
 */

const prisma = testDb();
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
      businessName: `Erase ${uniqueSlug("Mart")}`,
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

beforeAll(async () => {
  await ensurePlatformData();
}, 180_000);

afterAll(async () => {
  await purgeTestUsers(createdEmails);
  await disconnectTestDb();
});

describe("purging a company", () => {
  it("leaves no audit-log row behind, attached or detached", async () => {
    const email = `erase-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
    createdEmails.push(email);
    const result = await registerOwner(registrationInput(email));

    const ids = (
      await prisma.auditLog.findMany({
        where: { companyId: result.companyId },
        select: { id: true },
      })
    ).map((row) => row.id);

    // Registration writes its own trail, so there is something to erase. If
    // this is ever zero the test proves nothing, and should say so rather than
    // pass.
    expect(ids.length, "registration wrote no audit rows").toBeGreaterThan(0);

    await purgeCompany(result.companyId);

    const survivors = await prisma.auditLog.findMany({
      where: { id: { in: ids } },
      select: { id: true, companyId: true, actorEmail: true, ipAddress: true },
    });

    expect(
      survivors,
      `${survivors.length} audit rows survived the purge, detached rather than deleted`,
    ).toEqual([]);
  }, 180_000);

  it("leaves nothing behind in any company-scoped table", async () => {
    // The general form, and the reason the two cases above are not enough on
    // their own. Every company-scoped model is enumerated from the schema, so
    // a table added in six months is covered the day it appears rather than
    // the day somebody remembers to add it here.
    //
    // Rows are identified by id before the purge and looked for by id after.
    // Counting by `companyId` instead would have passed while this defect was
    // live: `SET NULL` empties that column, so the survivors match no company
    // and a count of the company's rows reads zero either way.
    const email = `erase-${uniqueSlug("z").replace(/-/g, "")}@example.com`;
    createdEmails.push(email);
    const result = await registerOwner(registrationInput(email));

    const client = prisma as unknown as Record<
      string,
      { findMany: (args: unknown) => Promise<Array<{ id: string }>> }
    >;
    const models = companyScopedModels().map((model) => model.name);

    const before = new Map<string, string[]>();
    for (const model of models) {
      const delegate = client[model[0]!.toLowerCase() + model.slice(1)];
      if (!delegate) continue;
      const rows = await delegate.findMany({
        where: { companyId: result.companyId },
        select: { id: true },
      });
      if (rows.length > 0)
        before.set(
          model,
          rows.map((row) => row.id),
        );
    }

    // Registration alone touches a good part of the schema. Asserting the
    // breadth keeps this from quietly becoming a test of nothing if
    // provisioning ever stops populating what it populates today.
    expect(
      before.size,
      "registration populated almost nothing, so this proves almost nothing",
    ).toBeGreaterThan(8);

    await purgeCompany(result.companyId);

    const survivors: string[] = [];
    for (const [model, ids] of before) {
      const delegate = client[model[0]!.toLowerCase() + model.slice(1)];
      const left = await delegate!.findMany({
        where: { id: { in: ids } },
        select: { id: true },
      });
      if (left.length > 0) survivors.push(`${model} (${left.length})`);
    }

    expect(
      survivors,
      `rows survived the purge in: ${survivors.join(", ")}`,
    ).toEqual([]);
  }, 180_000);

  it("leaves no session behind either", async () => {
    // Same shape, same `SetNull`: a session row outliving the company it was
    // acting within keeps the user agent and IP it was created with.
    const email = `erase-${uniqueSlug("y").replace(/-/g, "")}@example.com`;
    createdEmails.push(email);
    const result = await registerOwner(registrationInput(email));

    await prisma.session.create({
      data: {
        userId: result.userId,
        companyId: result.companyId,
        tokenHash: `probe-${uniqueSlug("t")}`,
        expiresAt: new Date(Date.now() + 86_400_000),
        ipAddress: "203.0.113.7",
        userAgent: "probe",
      },
    });

    const before = await prisma.session.count({
      where: { companyId: result.companyId },
    });
    expect(before).toBeGreaterThan(0);

    await purgeCompany(result.companyId);

    const detached = await prisma.session.count({
      where: { userId: result.userId, companyId: null },
    });
    expect(
      detached,
      "sessions survived the purge with their company detached",
    ).toBe(0);
  }, 180_000);
});
