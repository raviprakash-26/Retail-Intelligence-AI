import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import { trialBalanceIsBalanced } from "@/lib/accounting/double-entry";
import { subtract, toStorageString } from "@/lib/money";
import type { RegisterInput } from "@/lib/validation/auth";
import type { EmployeeInput } from "@/lib/validation/master-data";
import { registerOwner } from "@/server/auth/registration";
import { createPayment } from "@/server/settlements/settlement-service";
import type { PaymentInput } from "@/lib/validation/settlements";
import { createEmployee } from "@/server/master-data/employee-service";
import {
  createPayrollRun,
  voidPayroll,
  previewPayroll,
  listPayrollRuns,
  getPayrollRun,
  payrollPolicy,
  PayrollError,
} from "@/server/payroll/payroll-service";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * Payroll.
 *
 * The arithmetic is unit-tested; what needs a database is the posting. Payroll
 * is the one transaction where the obvious entry is wrong — gross is an
 * expense and net is a liability, but the gap between them is four separate
 * debts to four separate authorities, and an entry that lumps them balances
 * perfectly while being useless.
 */

const prisma = testDb();
const createdCompanies: string[] = [];
const createdEmails: string[] = [];

const today = new Date().toISOString().slice(0, 10);

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
      businessName: `Payroll ${uniqueSlug("Mart")}`,
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

type Fixture = { companyId: string; userId: string; actorEmail: string };

async function createCompany(policy?: {
  providentFund?: boolean;
  esi?: boolean;
  professionalTax?: number | null;
  professionalTaxThreshold?: number | null;
}): Promise<Fixture> {
  const email = `pay-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const result = await registerOwner(registrationInput(email));
  createdCompanies.push(result.companyId);

  if (policy) {
    await prisma.company.update({
      where: { id: result.companyId },
      data: {
        providentFundApplicable: policy.providentFund ?? false,
        esiApplicable: policy.esi ?? false,
        professionalTaxMonthly: policy.professionalTax ?? null,
        professionalTaxThreshold: policy.professionalTaxThreshold ?? null,
      },
    });
  }

  return {
    companyId: result.companyId,
    userId: result.userId,
    actorEmail: "owner@example.com",
  };
}

async function hire(
  fixture: Fixture,
  name: string,
  basicSalary: number,
  allowances = 0,
  dates: { joiningDate?: string; exitDate?: string } = {},
) {
  return createEmployee({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: fixture.actorEmail,
    input: {
      name,
      email: "",
      phone: "",
      department: "",
      designation: "Sales assistant",
      joiningDate: dates.joiningDate ?? "2025-04-01",
      exitDate: dates.exitDate ?? "",
      status: "ACTIVE",
      basicSalary,
      allowances,
      panNumber: "",
      bankAccountNo: "",
      ifsc: "",
    } satisfies EmployeeInput,
  });
}

async function accountBalance(
  companyId: string,
  systemKey: string,
): Promise<string> {
  const account = await prisma.account.findFirstOrThrow({
    where: { companyId, systemKey },
    select: { id: true },
  });
  const totals = await prisma.journalLine.aggregate({
    where: { companyId, accountId: account.id, status: "POSTED" },
    _sum: { debit: true, credit: true },
  });
  return toStorageString(
    subtract(totals._sum.debit ?? 0, totals._sum.credit ?? 0),
  );
}

async function assertTrialBalances(companyId: string): Promise<void> {
  const lines = await prisma.journalLine.groupBy({
    by: ["accountId"],
    where: { companyId, status: "POSTED" },
    _sum: { debit: true, credit: true },
  });
  const trial = trialBalanceIsBalanced(
    lines.map((line) => ({
      debit: line._sum.debit ?? 0,
      credit: line._sum.credit ?? 0,
    })),
  );
  expect(trial.difference.toString()).toBe("0");
}

const run = (fixture: Fixture, month = 6, year = 2026) =>
  createPayrollRun({
    companyId: fixture.companyId,
    userId: fixture.userId,
    actorEmail: fixture.actorEmail,
    branchId: null,
    year,
    month,
    payDate: today,
  });

beforeAll(async () => {
  await ensurePlatformData();
}, 60_000);

afterAll(async () => {
  for (const companyId of createdCompanies) {
    await purgeTestCompany(companyId).catch(() => undefined);
  }
  await purgeTestUsers(createdEmails);
  await disconnectTestDb();
}, 60_000);

describe("what a payroll run posts", () => {
  it("leaves the books balanced", async () => {
    const fixture = await createCompany({
      providentFund: true,
      esi: true,
      professionalTax: 200,
    });
    await hire(fixture, "Priya Nair", 12_000, 3_000);
    await hire(fixture, "Arun Kumar", 30_000, 5_000);

    await run(fixture);
    await assertTrialBalances(fixture.companyId);
  }, 90_000);

  it("expenses the gross and owes the net, which are different figures", async () => {
    const fixture = await createCompany({ providentFund: true });
    await hire(fixture, "Priya Nair", 10_000, 0);

    await run(fixture);

    // Gross 10,000 is the cost; net 8,800 is what the employee is owed.
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.SALARY_EXPENSE),
    ).toBe(toStorageString(10_000));
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.SALARY_PAYABLE),
    ).toBe(toStorageString(-8_800));
  }, 90_000);

  it("owes each authority separately rather than lumping the deductions", async () => {
    // The whole point of splitting them: "what do I owe the EPFO this month"
    // has to be answerable, and it cannot be from a single deductions figure.
    const fixture = await createCompany({
      providentFund: true,
      esi: true,
      professionalTax: 200,
    });
    await hire(fixture, "Arun Kumar", 30_000, 0);

    await run(fixture);

    // PF: 12% of the 15,000 ceiling, employee and employer both = 1,800 each.
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.PF_PAYABLE),
    ).toBe(toStorageString(-3_600));
    // Gross 30,000 is above the ESI limit, so nobody is in the scheme.
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.ESI_PAYABLE),
    ).toBe(toStorageString(0));
    // Professional tax above the threshold.
    expect(
      await accountBalance(
        fixture.companyId,
        SYSTEM_ACCOUNT.PROFESSIONAL_TAX_PAYABLE,
      ),
    ).toBe(toStorageString(-200));
  }, 90_000);

  it("treats the employer's contribution as a cost, not a deduction", async () => {
    const fixture = await createCompany({ providentFund: true });
    await hire(fixture, "Priya Nair", 10_000, 0);

    await run(fixture);

    // The employer's 1,200 is its own expense line, not inside salaries.
    expect(
      await accountBalance(
        fixture.companyId,
        SYSTEM_ACCOUNT.EMPLOYER_CONTRIBUTIONS,
      ),
    ).toBe(toStorageString(1_200));
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.SALARY_EXPENSE),
    ).toBe(toStorageString(10_000));
  }, 90_000);

  it("posts nothing statutory when the business is registered for nothing", async () => {
    const fixture = await createCompany();
    await hire(fixture, "Priya Nair", 10_000, 2_000);

    await run(fixture);

    // Gross equals net: the whole 12,000 is owed to the employee.
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.SALARY_PAYABLE),
    ).toBe(toStorageString(-12_000));
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.PF_PAYABLE),
    ).toBe(toStorageString(0));
    await assertTrialBalances(fixture.companyId);
  }, 90_000);

  it("records a payslip per employee that reconciles to the run", async () => {
    const fixture = await createCompany({ providentFund: true, esi: true });
    await hire(fixture, "Priya Nair", 8_000, 1_000);
    await hire(fixture, "Arun Kumar", 12_000, 2_000);

    const posted = await run(fixture);
    const { run: record } = await getPayrollRun({
      companyId: fixture.companyId,
      id: posted.id,
    });

    expect(record.items).toHaveLength(2);
    const netSum = record.items.reduce(
      (sum, item) => sum + Number(item.netSalary),
      0,
    );
    expect(netSum).toBeCloseTo(Number(record.netAmount), 2);
    expect(
      Number(record.grossAmount) - Number(record.deductionAmount),
    ).toBeCloseTo(Number(record.netAmount), 2);
  }, 90_000);
});

describe("the preview", () => {
  it("says what a run would come to without posting it", async () => {
    const fixture = await createCompany({ providentFund: true });
    await hire(fixture, "Priya Nair", 10_000, 0);

    const preview = await previewPayroll({
      companyId: fixture.companyId,
      year: 2026,
      month: 6,
    });

    expect(preview.payslips).toHaveLength(1);
    expect(Number(preview.totals.net)).toBeCloseTo(8_800, 2);
    expect(preview.alreadyRun).toBe(false);

    // Nothing was written.
    expect(await listPayrollRuns(fixture.companyId)).toHaveLength(0);
  }, 90_000);

  it("says plainly that it does not work out TDS", async () => {
    const fixture = await createCompany();
    await hire(fixture, "Priya Nair", 60_000, 0);

    const preview = await previewPayroll({
      companyId: fixture.companyId,
      year: 2026,
      month: 6,
    });

    expect(preview.notes.join(" ")).toMatch(/TDS is not calculated/i);
    expect(Number(preview.totals.taxDeductedAtSource)).toBe(0);
  }, 90_000);

  it("carries an entered TDS figure through to the payslip", async () => {
    const fixture = await createCompany();
    const employee = await hire(fixture, "Priya Nair", 60_000, 0);

    const preview = await previewPayroll({
      companyId: fixture.companyId,
      year: 2026,
      month: 6,
      taxDeducted: { [employee.id]: 5_000 },
    });

    expect(Number(preview.totals.taxDeductedAtSource)).toBe(5_000);
    expect(Number(preview.totals.net)).toBeCloseTo(55_000, 2);
  }, 90_000);

  it("notices a period that has already been run", async () => {
    const fixture = await createCompany();
    await hire(fixture, "Priya Nair", 10_000, 0);
    await run(fixture);

    const preview = await previewPayroll({
      companyId: fixture.companyId,
      year: 2026,
      month: 6,
    });
    expect(preview.alreadyRun).toBe(true);
  }, 90_000);
});

describe("what payroll refuses to do", () => {
  it("will not run the same period twice", async () => {
    // Paying twice is easy to do and expensive to undo.
    const fixture = await createCompany();
    await hire(fixture, "Priya Nair", 10_000, 0);
    await run(fixture);

    await expect(run(fixture)).rejects.toThrow(/already been run/i);
  }, 90_000);

  it("will not run with nobody to pay", async () => {
    const fixture = await createCompany();
    await expect(run(fixture)).rejects.toThrow(PayrollError);
  }, 90_000);

  /**
   * A payslip cannot be negative.
   *
   * TDS is the one figure on the run form a person types — the platform will
   * not compute it and says so — and a slipped digit puts 50,000 where 5,000
   * was meant. That is inside the schema's ceiling and looks like every other
   * number on the page.
   *
   * The second of these is the one that mattered. Alone, an over-withheld
   * employee never reached the ledger: the funnel refused a negative credit.
   * Beside a colleague whose pay covered it, the run's total came out
   * positive, the entry balanced, and it posted — a payslip reading net
   * -20,000, and Salary Payable credited with the sum of a real debt and a
   * fiction. So the check is per employee, because the total is exactly what
   * hides it.
   */
  it("will not withhold more tax than an employee is paid", async () => {
    const fixture = await createCompany();
    const employee = await hire(fixture, "Meena Kumari", 30_000, 0);

    await expect(
      createPayrollRun({
        ...fixture,
        branchId: null,
        year: 2026,
        month: 6,
        payDate: today,
        taxDeducted: { [employee.id]: 50_000 },
      }),
    ).rejects.toThrow(
      /More tax is being withheld than there is pay.*Meena Kumari \(50000\.00 withheld from 30000\.00\)/,
    );

    // Refused before anything was written, not rolled back from halfway.
    expect(await listPayrollRuns(fixture.companyId)).toHaveLength(0);
  }, 90_000);

  it("will not let one employee's pay cover another's over-withholding", async () => {
    const fixture = await createCompany();
    const [manager, assistant] = await Promise.all([
      hire(fixture, "Anand Rao", 90_000, 0),
      hire(fixture, "Meena Kumari", 30_000, 0),
    ]);

    await expect(
      createPayrollRun({
        ...fixture,
        branchId: null,
        year: 2026,
        month: 6,
        payDate: today,
        // 69,000 in total, which is an ordinary month's net for these two and
        // balances perfectly. It used to post.
        taxDeducted: { [manager.id]: 1_000, [assistant.id]: 50_000 },
      }),
    ).rejects.toThrow(/Meena Kumari/);

    expect(await listPayrollRuns(fixture.companyId)).toHaveLength(0);
    const slips = await prisma.payrollItem.count({
      where: { companyId: fixture.companyId },
    });
    expect(slips).toBe(0);
  }, 120_000);

  it("names every employee that is wrong, not just the first", async () => {
    // A pasted column is wrong in more than one row, and fixing them one run
    // at a time is a worse afternoon than being told all of them at once.
    const fixture = await createCompany();
    const [one, two] = await Promise.all([
      hire(fixture, "Anand Rao", 90_000, 0),
      hire(fixture, "Meena Kumari", 30_000, 0),
    ]);

    const refusal = await createPayrollRun({
      ...fixture,
      branchId: null,
      year: 2026,
      month: 6,
      payDate: today,
      taxDeducted: { [one.id]: 95_000, [two.id]: 50_000 },
    }).then(
      () => null,
      (error: unknown) => error as PayrollError,
    );

    expect(refusal?.code).toBe("WITHHOLDING_EXCEEDS_PAY");
    expect(refusal?.message).toMatch(/Anand Rao/);
    expect(refusal?.message).toMatch(/Meena Kumari/);
    expect(refusal?.message).toMatch(/those employees/);
  }, 120_000);

  it("pays a whole month's wage over as tax, which is odd but not wrong", async () => {
    // The boundary the check has to leave alone. Withholding exactly the pay
    // leaves nothing to hand over and no debt either way, and the entry simply
    // has no salary payable line — `condenseLines` drops it.
    const fixture = await createCompany();
    const employee = await hire(fixture, "Meena Kumari", 30_000, 0);

    const posted = await createPayrollRun({
      ...fixture,
      branchId: null,
      year: 2026,
      month: 6,
      payDate: today,
      taxDeducted: { [employee.id]: 30_000 },
    });

    expect(posted.netAmount).toBe(toStorageString(0));
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.SALARY_PAYABLE),
    ).toBe(toStorageString(0));
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.TDS_PAYABLE),
    ).toBe(toStorageString(-30_000));
  }, 90_000);

  it("will not touch another company's run", async () => {
    const [mine, theirs] = await Promise.all([
      createCompany(),
      createCompany(),
    ]);
    await hire(theirs, "Priya Nair", 10_000, 0);
    const posted = await run(theirs);

    await expect(
      getPayrollRun({ companyId: mine.companyId, id: posted.id }),
    ).rejects.toThrow(/could not be found/i);
  }, 120_000);

  it("keeps one company's payroll out of another's books", async () => {
    const [mine, theirs] = await Promise.all([
      createCompany({ providentFund: true }),
      createCompany({ providentFund: true }),
    ]);
    await hire(theirs, "Arun Kumar", 30_000, 0);
    await run(theirs);

    expect(
      await accountBalance(mine.companyId, SYSTEM_ACCOUNT.SALARY_EXPENSE),
    ).toBe(toStorageString(0));
    expect(await listPayrollRuns(mine.companyId)).toHaveLength(0);
  }, 120_000);
});

/**
 * The wage above which professional tax is levied.
 *
 * The monthly amount was settable and this was not, so a business outside
 * Karnataka could say what it withheld but not from what wage — and Bengaluru's
 * ₹25,000 was applied to everyone. A shop in a state levying from ₹7,500
 * withheld nothing from anybody under ₹25,000, having told the software it was
 * liable. These cases run the whole way through the database, because the
 * arithmetic being right is no use if the figure never reaches it.
 */
describe("professional tax outside Karnataka", () => {
  it("carries the threshold from the company through to the payslip", async () => {
    const fixture = await createCompany({
      professionalTax: 200,
      professionalTaxThreshold: 7_500,
    });
    await hire(fixture, "Clerk", 20_000);

    const policy = await payrollPolicy(fixture.companyId);
    expect(policy.professionalTaxThreshold).toBe(7_500);

    const preview = await previewPayroll({
      companyId: fixture.companyId,
      year: 2026,
      month: 6,
    });
    expect(Number(preview.totals.professionalTax)).toBe(200);
  }, 90_000);

  it("leaves a business that set only the amount exactly where it was", async () => {
    // Every tenant configured before the threshold existed is in this state,
    // and none of their payrolls may move by a rupee.
    const fixture = await createCompany({ professionalTax: 200 });
    await hire(fixture, "Clerk", 20_000);

    const policy = await payrollPolicy(fixture.companyId);
    expect(policy.professionalTaxThreshold).toBeNull();

    const preview = await previewPayroll({
      companyId: fixture.companyId,
      year: 2026,
      month: 6,
    });
    expect(Number(preview.totals.professionalTax)).toBe(0);
  }, 90_000);
});

/**
 * Who was actually on the payroll that month.
 *
 * The period is chosen by whoever runs it, and the validation allows any month
 * from 2000 to 2100 — which is right, because a shop that has fallen behind
 * catches up by running the months it missed. The employees were selected by
 * status alone.
 *
 * So somebody hired last week appeared on a payroll for a month before they
 * joined: paid, deducted from, and posted to the ledger as a cost of a month
 * they had nothing to do with. `joiningDate` is required on every employee and
 * `exitDate` is kept beside it; both were recorded and neither was read.
 *
 * The dates decide who is on the run. Joining or leaving *during* the month
 * still puts somebody on it — what they are owed for a part-month is a
 * proration question, which this does not answer and does not pretend to.
 */
describe("who is on a run", () => {
  it("leaves out somebody who had not joined yet", async () => {
    const fixture = await createCompany({ providentFund: true });
    await hire(fixture, "Priya Nair", 10_000, 0, {
      joiningDate: "2026-07-15",
    });

    const preview = await previewPayroll({
      companyId: fixture.companyId,
      year: 2026,
      month: 6,
    });

    expect(preview.payslips).toHaveLength(0);
    expect(Number(preview.totals.gross)).toBe(0);
  }, 90_000);

  /**
   * Somebody on leave is still employed.
   *
   * `ON_LEAVE` is one of the four statuses an employee can hold, and the staff
   * list treats it as current — `includeFormer` has to be asked for before a
   * person on leave is hidden, because they have not left. Payroll selected on
   * `status: "ACTIVE"` alone, so they vanished from the run: no payslip, no
   * salary posted, no deduction, and nothing said about it.
   *
   * Not a smaller figure. Absent — which is how it goes unnoticed until
   * somebody on maternity or medical leave asks why they were not paid.
   */
  it("pays somebody who is on leave", async () => {
    const fixture = await createCompany({ providentFund: true });
    const employee = await hire(fixture, "Anita Rao", 10_000, 0, {
      joiningDate: "2025-04-01",
    });

    const { updateEmployee } =
      await import("@/server/master-data/employee-service");
    await updateEmployee({
      companyId: fixture.companyId,
      employeeId: employee.id,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: {
        name: "Anita Rao",
        email: "",
        phone: "",
        department: "",
        designation: "Sales assistant",
        joiningDate: "2025-04-01",
        exitDate: "",
        status: "ON_LEAVE",
        basicSalary: 10_000,
        allowances: 0,
        panNumber: "",
        bankAccountNo: "",
        ifsc: "",
      },
    });

    const preview = await previewPayroll({
      companyId: fixture.companyId,
      year: 2026,
      month: 6,
    });

    expect(preview.payslips).toHaveLength(1);
    expect(Number(preview.totals.gross)).toBe(10_000);
  }, 90_000);

  it("leaves out somebody who had already left", async () => {
    // The exit date is recorded when notice is given, which is before the
    // status is moved off ACTIVE — so for a while both are true of the record.
    const fixture = await createCompany({ providentFund: true });
    await hire(fixture, "Ramesh Gowda", 10_000, 0, {
      joiningDate: "2025-04-01",
      exitDate: "2026-05-20",
    });

    const preview = await previewPayroll({
      companyId: fixture.companyId,
      year: 2026,
      month: 6,
    });

    expect(preview.payslips).toHaveLength(0);
  }, 90_000);

  it("still pays somebody who joined or left during the month", async () => {
    // The other half. A guard on the dates that excluded a part-month would
    // drop the joiner's first pay and the leaver's last, which is worse than
    // the thing it fixes and would not be noticed until somebody complained.
    const fixture = await createCompany({ providentFund: true });
    await hire(fixture, "Joined Midway", 10_000, 0, {
      joiningDate: "2026-06-15",
    });
    await hire(fixture, "Left Midway", 10_000, 0, {
      joiningDate: "2025-04-01",
      exitDate: "2026-06-10",
    });

    const preview = await previewPayroll({
      companyId: fixture.companyId,
      year: 2026,
      month: 6,
    });

    expect(preview.payslips).toHaveLength(2);
  }, 90_000);
});

/**
 * Paying what the run said was owed.
 *
 * A run charges the wages to the profit and loss account once and posts what is
 * owed — the staff's net pay and four withholdings, to four authorities. Every
 * one of those is a credit to a liability, and nothing could debit them: the
 * payments screen offered supplier, drawings, loan repayment and "other", and
 * other goes to miscellaneous expenses.
 *
 * So the money leaving had to be recorded as an expense of its own — through
 * "other", or through the expense form's `Salary` category and straight back
 * into `SALARY_EXPENSE`, which the expenses page invites in as many words. The
 * same wages were charged twice, the profit was understated by a month's
 * payroll every month, and the debts stood for as long as the business ran
 * payroll.
 */
describe("settling what a payroll run owes", () => {
  function pay(fixture: Fixture, kind: PaymentInput["kind"], amount: number) {
    return createPayment({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: {
        kind,
        partyId: "",
        date: today,
        paymentMode: "BANK",
        amount,
        referenceNo: "",
        notes: "",
        allocations: [],
      } satisfies PaymentInput,
    });
  }

  it("clears every debt it created and charges the wages once", async () => {
    // Gross of ₹16,000: inside the ESI limit, over the professional tax
    // threshold this business has set, and PF on the basic. All four
    // withholdings apply, so all four debts are on the books to settle.
    const fixture = await createCompany({
      providentFund: true,
      esi: true,
      professionalTax: 200,
      professionalTaxThreshold: 15_000,
    });
    await hire(fixture, "Anita Rao", 12_000, 4_000);

    const posted = await run(fixture);

    // What the run says is owed, before anything is paid.
    const owed = {
      staff: await accountBalance(
        fixture.companyId,
        SYSTEM_ACCOUNT.SALARY_PAYABLE,
      ),
      pf: await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.PF_PAYABLE),
      esi: await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.ESI_PAYABLE),
      tax: await accountBalance(
        fixture.companyId,
        SYSTEM_ACCOUNT.PROFESSIONAL_TAX_PAYABLE,
      ),
    };
    // Credits, so the net debit is negative.
    expect(Number(owed.staff)).toBeLessThan(0);
    expect(Number(owed.pf)).toBeLessThan(0);
    expect(Number(owed.esi)).toBeLessThan(0);
    expect(Number(owed.tax)).toBeLessThan(0);

    const wagesAfterRun = await accountBalance(
      fixture.companyId,
      SYSTEM_ACCOUNT.SALARY_EXPENSE,
    );
    expect(wagesAfterRun).toBe(toStorageString(posted.grossAmount));

    await pay(fixture, "STAFF_PAY", -Number(owed.staff));
    await pay(fixture, "PROVIDENT_FUND", -Number(owed.pf));
    await pay(fixture, "EMPLOYEE_INSURANCE", -Number(owed.esi));
    await pay(fixture, "PROFESSIONAL_TAX", -Number(owed.tax));

    // Every debt back to nil.
    for (const key of [
      SYSTEM_ACCOUNT.SALARY_PAYABLE,
      SYSTEM_ACCOUNT.PF_PAYABLE,
      SYSTEM_ACCOUNT.ESI_PAYABLE,
      SYSTEM_ACCOUNT.PROFESSIONAL_TAX_PAYABLE,
    ]) {
      expect(await accountBalance(fixture.companyId, key)).toBe(
        toStorageString(0),
      );
    }

    // And the wages charged once, not twice. This is the figure the whole
    // thing is about: paying staff is settling a debt, not incurring a cost.
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.SALARY_EXPENSE),
    ).toBe(wagesAfterRun);
    expect(
      await accountBalance(
        fixture.companyId,
        SYSTEM_ACCOUNT.MISCELLANEOUS_EXPENSE,
      ),
    ).toBe(toStorageString(0));

    await assertTrialBalances(fixture.companyId);
  }, 90_000);

  it("still sends a payment with no debt behind it to expenses", async () => {
    // The new purposes settle debts; "other" is still what it was, and has to
    // stay that way — a shopkeeper paying for something the books have never
    // heard of is incurring a cost, not clearing one.
    const fixture = await createCompany();

    await pay(fixture, "OTHER", 500);

    expect(
      await accountBalance(
        fixture.companyId,
        SYSTEM_ACCOUNT.MISCELLANEOUS_EXPENSE,
      ),
    ).toBe(toStorageString(500));

    await assertTrialBalances(fixture.companyId);
  }, 60_000);
});

/**
 * Undoing a run.
 *
 * The last document in the product that could not be undone. An invoice, a
 * bill, an expense, a receipt, a payment and a journal voucher all reverse
 * through `reversePostedEntry`; payroll reversed through nothing. A month
 * posted with the wrong pay date, or against a salary corrected afterwards, was
 * permanent — and the period was shut to a second attempt for good, because
 * `createPayrollRun` refuses one that already has a run.
 *
 * That refusal always had an exception for a cancelled run, and nothing ever
 * set CANCELLED, so the exception was unreachable. Had it been reached the
 * insert behind it would have failed anyway: the unique index on the period did
 * not care what the old row's status was. It is partial now, the way the
 * one-current-fiscal-year and one-primary-branch rules are, so the rule is what
 * it always said — one *live* run per period.
 */
describe("cancelling a payroll run", () => {
  const cancel = (fixture: Fixture, payrollId: string) =>
    voidPayroll({
      companyId: fixture.companyId,
      payrollId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      reason: "Posted against the wrong pay date",
    });

  it("reverses the entry and leaves the books where they started", async () => {
    const fixture = await createCompany({ providentFund: true });
    await hire(fixture, "Anita Rao", 12_000, 4_000);

    const posted = await run(fixture);
    expect(
      await accountBalance(fixture.companyId, SYSTEM_ACCOUNT.SALARY_EXPENSE),
    ).toBe(toStorageString(posted.grossAmount));

    const cancelled = await cancel(fixture, posted.id);
    expect(cancelled.reference).toBe(posted.reference);

    // Every account the run touched, back to nil.
    for (const key of [
      SYSTEM_ACCOUNT.SALARY_EXPENSE,
      SYSTEM_ACCOUNT.EMPLOYER_CONTRIBUTIONS,
      SYSTEM_ACCOUNT.SALARY_PAYABLE,
      SYSTEM_ACCOUNT.PF_PAYABLE,
    ]) {
      expect(await accountBalance(fixture.companyId, key)).toBe(
        toStorageString(0),
      );
    }

    // The original entry stays in the ledger beside its reversal.
    const entries = await prisma.journalEntry.findMany({
      where: { companyId: fixture.companyId, voucherType: "PAYROLL" },
      select: { status: true },
    });
    expect(entries).toHaveLength(2);
    expect(entries.filter((e) => e.status === "REVERSED")).toHaveLength(1);
    expect(entries.filter((e) => e.status === "POSTED")).toHaveLength(1);

    await assertTrialBalances(fixture.companyId);
  }, 90_000);

  it("lets the month be run again, which is the point of it", async () => {
    const fixture = await createCompany();
    await hire(fixture, "Anita Rao", 12_000, 4_000);

    const first = await run(fixture);
    await expect(run(fixture)).rejects.toThrow(/has already been run/);

    await cancel(fixture, first.id);

    // The guard's own exception, reachable at last — and the partial index is
    // what lets the insert behind it through.
    const second = await run(fixture);
    expect(second.reference).not.toBe(first.reference);
    await assertTrialBalances(fixture.companyId);
  }, 90_000);

  it("still refuses a third run once the replacement is live", async () => {
    // The period now holds a cancelled run *and* its replacement. Reading any
    // run and then asking whether that one was cancelled is a different
    // question from asking whether a live one exists, and `findFirst` has no
    // ordering — so the guard could pick the cancelled row, pass, and let the
    // insert hit the unique index. What the shopkeeper saw was a constraint
    // error rather than the sentence the guard is written to produce.
    const fixture = await createCompany();
    await hire(fixture, "Anita Rao", 12_000, 4_000);

    const first = await run(fixture);
    await cancel(fixture, first.id);
    await run(fixture);

    await expect(run(fixture)).rejects.toThrow(/has already been run/);

    // And the form says so too, rather than offering to post a third.
    const preview = await previewPayroll({
      companyId: fixture.companyId,
      year: 2026,
      month: 6,
    });
    expect(preview.alreadyRun).toBe(true);
  }, 90_000);

  it("keeps the cancelled run readable rather than deleting it", async () => {
    const fixture = await createCompany();
    await hire(fixture, "Anita Rao", 12_000, 4_000);
    const posted = await run(fixture);

    await cancel(fixture, posted.id);

    const stored = await prisma.payroll.findUniqueOrThrow({
      where: { id: posted.id },
      select: {
        status: true,
        reference: true,
        _count: { select: { items: true } },
      },
    });
    expect(stored.status).toBe("CANCELLED");
    expect(stored.reference).toBe(posted.reference);
    // The payslips are the evidence of what was paid and why it was undone.
    expect(stored._count.items).toBe(1);
  }, 90_000);

  it("refuses a second cancellation", async () => {
    const fixture = await createCompany();
    await hire(fixture, "Anita Rao", 12_000, 4_000);
    const posted = await run(fixture);

    await cancel(fixture, posted.id);
    await expect(cancel(fixture, posted.id)).rejects.toThrow(
      /already been cancelled/,
    );
  }, 90_000);

  it("refuses once what it owed has been paid over", async () => {
    const fixture = await createCompany({ providentFund: true });
    await hire(fixture, "Anita Rao", 12_000, 4_000);
    const posted = await run(fixture);

    // The staff are paid. There is no allocation tying that payment to this
    // run, so what can be asked is whether the debt is still on the books —
    // and it is not.
    const owed = await accountBalance(
      fixture.companyId,
      SYSTEM_ACCOUNT.SALARY_PAYABLE,
    );
    await createPayment({
      companyId: fixture.companyId,
      userId: fixture.userId,
      actorEmail: fixture.actorEmail,
      input: {
        kind: "STAFF_PAY",
        partyId: "",
        date: today,
        paymentMode: "BANK",
        amount: -Number(owed),
        referenceNo: "",
        notes: "",
        allocations: [],
      } satisfies PaymentInput,
    });

    await expect(cancel(fixture, posted.id)).rejects.toThrow(
      /already been paid over/,
    );

    // And nothing was half-done: the run is still live and the books still add.
    const stored = await prisma.payroll.findUniqueOrThrow({
      where: { id: posted.id },
      select: { status: true },
    });
    expect(stored.status).toBe("APPROVED");
    await assertTrialBalances(fixture.companyId);
  }, 90_000);
});
