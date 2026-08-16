import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RegisterInput } from "@/lib/validation/auth";
import type { EmployeeInput } from "@/lib/validation/master-data";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import { registerOwner } from "@/server/auth/registration";
import { createEmployee } from "@/server/master-data/employee-service";
import { MissingAccountError } from "@/server/documents/accounts";
import { createPayrollRun } from "@/server/payroll/payroll-service";
import { reconcileCompanyChart } from "@/server/provisioning/chart-reconciler";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * A company gets the system accounts added after it signed up.
 *
 * The chart is copied from a static definition at provisioning and was never
 * revisited, which was invisible until the chart grew. The payroll release
 * added `PF_PAYABLE`, `ESI_PAYABLE`, `PROFESSIONAL_TAX_PAYABLE` and
 * `EMPLOYER_CONTRIBUTIONS`; posting a run resolves all four, and
 * `resolveSystemAccounts` throws when one is absent. Every business that
 * signed up before that release could open the payroll screen, fill it in and
 * be unable to post, with no way out from inside the product.
 *
 * The first case below is that outage, reproduced by deleting exactly what
 * such a tenant would never have had.
 */

const prisma = testDb();
const createdCompanies: string[] = [];
const createdEmails: string[] = [];

const now = new Date();
const TODAY = {
  year: now.getUTCFullYear(),
  month: now.getUTCMonth() + 1,
  iso: now.toISOString().slice(0, 10),
};

const PAYROLL_ACCOUNTS = [
  SYSTEM_ACCOUNT.PF_PAYABLE,
  SYSTEM_ACCOUNT.ESI_PAYABLE,
  SYSTEM_ACCOUNT.PROFESSIONAL_TAX_PAYABLE,
  SYSTEM_ACCOUNT.EMPLOYER_CONTRIBUTIONS,
];

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
      businessName: `Chart ${uniqueSlug("Mart")}`,
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
      openingCashBalance: 500_000,
      openingBankBalance: 0,
      inventoryMethod: "WEIGHTED_AVERAGE",
      loadDemoData: false,
    },
  };
}

/** A tenant as it would look had it signed up before the payroll release. */
async function companyFromBeforeThePayrollRelease() {
  const email = `chart-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const result = await registerOwner(registrationInput(email));
  createdCompanies.push(result.companyId);

  await prisma.account.deleteMany({
    where: { companyId: result.companyId, systemKey: { in: PAYROLL_ACCOUNTS } },
  });

  return result;
}

beforeAll(async () => {
  await ensurePlatformData();
}, 180_000);

afterAll(async () => {
  for (const companyId of createdCompanies) await purgeTestCompany(companyId);
  await purgeTestUsers(createdEmails);
  await disconnectTestDb();
});

describe("a chart that predates a release", () => {
  it("cannot post payroll, which is the outage this fixes", async () => {
    const company = await companyFromBeforeThePayrollRelease();
    await prisma.company.update({
      where: { id: company.companyId },
      data: { providentFundApplicable: true },
    });

    await createEmployee({
      companyId: company.companyId,
      userId: company.userId,
      actorEmail: "owner@example.com",
      input: {
        name: "Anita Rao",
        email: "",
        phone: "",
        department: "",
        designation: "Sales assistant",
        joiningDate: "2025-04-01",
        exitDate: "",
        status: "ACTIVE",
        basicSalary: 20_000,
        allowances: 0,
        panNumber: "",
        bankAccountNo: "",
        ifsc: "",
      } satisfies EmployeeInput,
    });

    // Named, not merely `toThrow()`. A bare rejection would have been
    // satisfied by any failure at all — a missing argument, a date the fiscal
    // year does not cover — and the first draft of this test passed for
    // exactly that reason while proving nothing about the chart.
    await expect(
      createPayrollRun({
        companyId: company.companyId,
        userId: company.userId,
        actorEmail: "owner@example.com",
        branchId: null,
        year: TODAY.year,
        month: TODAY.month,
        payDate: TODAY.iso,
      }),
    ).rejects.toThrow(MissingAccountError);
  }, 180_000);

  it("can post it once the chart is reconciled", async () => {
    const company = await companyFromBeforeThePayrollRelease();
    await prisma.company.update({
      where: { id: company.companyId },
      data: { providentFundApplicable: true },
    });

    await createEmployee({
      companyId: company.companyId,
      userId: company.userId,
      actorEmail: "owner@example.com",
      input: {
        name: "Anita Rao",
        email: "",
        phone: "",
        department: "",
        designation: "Sales assistant",
        joiningDate: "2025-04-01",
        exitDate: "",
        status: "ACTIVE",
        basicSalary: 20_000,
        allowances: 0,
        panNumber: "",
        bankAccountNo: "",
        ifsc: "",
      } satisfies EmployeeInput,
    });

    const added = await reconcileCompanyChart(prisma, company.companyId);
    expect(added.accounts).toBe(PAYROLL_ACCOUNTS.length);

    const run = await createPayrollRun({
      companyId: company.companyId,
      userId: company.userId,
      actorEmail: "owner@example.com",
      branchId: null,
      year: TODAY.year,
      month: TODAY.month,
      payDate: TODAY.iso,
    });
    expect(run).toBeTruthy();

    // The accounts it was given are new, so they carry nothing from before.
    const restored = await prisma.account.findMany({
      where: {
        companyId: company.companyId,
        systemKey: { in: PAYROLL_ACCOUNTS },
      },
      select: { systemKey: true, openingBalance: true, isSystem: true },
    });
    expect(restored).toHaveLength(PAYROLL_ACCOUNTS.length);
    for (const account of restored) {
      expect(Number(account.openingBalance)).toBe(0);
      expect(account.isSystem).toBe(true);
    }
  }, 180_000);

  it("adds nothing to a company already up to date, and runs clean twice", async () => {
    const email = `chart-${uniqueSlug("y").replace(/-/g, "")}@example.com`;
    createdEmails.push(email);
    const result = await registerOwner(registrationInput(email));
    createdCompanies.push(result.companyId);

    const before = await prisma.account.count({
      where: { companyId: result.companyId },
    });

    const first = await reconcileCompanyChart(prisma, result.companyId);
    expect(first).toEqual({ groups: 0, accounts: 0 });

    const second = await reconcileCompanyChart(prisma, result.companyId);
    expect(second).toEqual({ groups: 0, accounts: 0 });

    expect(
      await prisma.account.count({ where: { companyId: result.companyId } }),
    ).toBe(before);
  }, 180_000);

  it("leaves a business's own accounts untouched", async () => {
    // The reason this is add-only. An account carries a balance and may have
    // been posted against; a pass that removed whatever the template lacks is
    // how a business loses its ledger.
    const company = await companyFromBeforeThePayrollRelease();

    const group = await prisma.accountGroup.findFirst({
      where: { companyId: company.companyId },
      select: { id: true },
    });
    const mine = await prisma.account.create({
      data: {
        companyId: company.companyId,
        groupId: group!.id,
        code: "9911",
        name: "Festival advance to staff",
        type: "ASSET",
        subType: "CURRENT_ASSET",
        nature: "DEBIT",
        section: "BALANCE_SHEET",
        isSystem: false,
        openingBalance: 1234,
        openingNature: "DEBIT",
      },
      select: { id: true },
    });

    await reconcileCompanyChart(prisma, company.companyId);

    const after = await prisma.account.findUnique({
      where: { id: mine.id },
      select: { name: true, openingBalance: true },
    });
    expect(after?.name).toBe("Festival advance to staff");
    expect(Number(after?.openingBalance)).toBe(1234);
  }, 180_000);
});
