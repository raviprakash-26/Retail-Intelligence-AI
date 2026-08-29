import "server-only";
import { PayrollStatus, VoucherType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import type { DraftJournalLine } from "@/lib/accounting/double-entry";
import {
  compare,
  isZero,
  subtract,
  toStorageString,
  type Decimal,
} from "@/lib/money";
import {
  computeStatutory,
  totalStatutory,
  type PayrollPolicy,
  type StatutoryResult,
} from "@/lib/payroll/statutory";
import { postJournalEntry } from "@/server/accounting/post-journal-entry";
import { reversePostedEntry } from "@/server/documents/reversal";
import { recordAuditLog } from "@/server/audit/audit-log";
import { resolveSystemAccounts } from "@/server/documents/accounts";
import { allocateDocumentNumber } from "@/server/sequences/document-sequence";
import { ensureFiscalYearFor } from "@/server/fiscal/fiscal-calendar";
import { CURRENT_EMPLOYEE_STATUSES } from "@/server/master-data/employee-service";

/**
 * Running payroll.
 *
 * A run is a document, and it behaves like every other document here: it is
 * computed on the server from records the tenant already holds, it posts one
 * balanced entry, and once posted it is not edited — a correction is a fresh
 * run or a reversal, never a rewrite.
 *
 * The entry is the part worth reading closely, because payroll is the one
 * transaction where the obvious posting is wrong. Gross pay is an expense and
 * net pay is a liability, but the difference between them is *not* one thing:
 * it is four separate debts to four separate authorities, each with its own due
 * date. Crediting them to a single "deductions" account would produce a
 * balanced entry that cannot answer "what do I owe the EPFO this month", which
 * is the only question the deduction exists to raise.
 *
 * The employer's own contributions are the other half of that. They are not
 * withheld from anybody — they are what the employee costs on top of the gross
 * — so they debit their own expense account and credit the same statutory
 * liabilities the employee's share does, because both halves are remitted
 * together in one payment.
 *
 *   Dr Salaries & Wages          gross
 *   Dr Employer Contributions    employer PF + ESI
 *     Cr Salary Payable          net
 *     Cr PF Payable              employee + employer share
 *     Cr ESI Payable             employee + employer share
 *     Cr Professional Tax Payable
 *     Cr TDS Payable
 */

export class PayrollError extends Error {
  constructor(
    message: string,
    readonly code:
      | "NO_EMPLOYEES"
      | "ALREADY_RUN"
      | "NOT_FOUND"
      | "NOT_POSTED"
      | "NOTHING_TO_PAY"
      | "ALREADY_CANCELLED"
      | "NO_ENTRY"
      | "ALREADY_SETTLED",
  ) {
    super(message);
    this.name = "PayrollError";
  }
}

export type PayslipPreview = {
  employeeId: string;
  employeeCode: string;
  name: string;
  designation: string | null;
  basicSalary: string;
  allowances: string;
  gross: string;
  employeeProvidentFund: string;
  employeeStateInsurance: string;
  professionalTax: string;
  taxDeductedAtSource: string;
  totalDeductions: string;
  net: string;
  employerProvidentFund: string;
  employerStateInsurance: string;
  costToCompany: string;
};

export type PayrollPreview = {
  periodYear: number;
  periodMonth: number;
  label: string;
  policy: PayrollPolicy;
  payslips: PayslipPreview[];
  totals: Omit<
    PayslipPreview,
    "employeeId" | "employeeCode" | "name" | "designation"
  >;
  /** True when a run for this period is already posted. */
  alreadyRun: boolean;
  /** Statements the figures must not be read without. */
  notes: string[];
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function periodLabel(year: number, month: number): string {
  return `${MONTHS[month - 1] ?? "Unknown"} ${year}`;
}

/**
 * Who was on the payroll for a month.
 *
 * The period is whichever the caller asks for — the validation allows any month
 * from 2000 to 2100, and rightly, because a shop that has fallen behind catches
 * up by running the months it missed. Employees were selected by status alone,
 * so somebody hired last week appeared on a payroll for a month before they
 * joined: paid, deducted from, and posted to the ledger as a cost of a month
 * they had nothing to do with. Every employee carries a joining date and most
 * carry an exit date; both were recorded and neither was read.
 *
 * The exit date matters for the same reason from the other end. It is entered
 * when notice is given, which is before anybody moves the status off ACTIVE, so
 * for a stretch the record says both things at once.
 *
 * Joining or leaving *during* the month still puts somebody on the run. What
 * they are owed for a part-month is a proration question this does not answer
 * and should not silently decide by dropping them.
 *
 * The same was true of status, one category over. Selecting on ACTIVE alone
 * dropped everybody on leave — and somebody on leave has not left, which is
 * why the staff list counts them as current and asks for `includeFormer`
 * before hiding them. So they were on the team page and absent from the
 * payroll: no payslip, no salary posted, no deduction, and nothing said about
 * it. `CURRENT_EMPLOYEE_STATUSES` is that list's own definition, shared rather
 * than restated.
 *
 * What this still does not do is pay somebody whose status has already been
 * moved to RESIGNED or TERMINATED for the part of the month they worked. The
 * exit date is what records leaving and the window above reads it, but once
 * the status has been changed they drop out regardless. Final settlement is a
 * flow this product does not have, and inventing one here — deciding what a
 * leaver is owed — is not something to do quietly in a `where` clause.
 */
function employedDuring(year: number, month: number) {
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  // Day zero of the following month is the last day of this one, which saves
  // knowing which months have thirty days and which Februaries have twenty-nine.
  const monthEnd = new Date(Date.UTC(year, month, 0));

  return {
    joiningDate: { lte: monthEnd },
    OR: [{ exitDate: null }, { exitDate: { gte: monthStart } }],
  };
}

/** The company's scheme registrations, which are facts it tells us. */
export async function payrollPolicy(companyId: string): Promise<PayrollPolicy> {
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    select: {
      providentFundApplicable: true,
      esiApplicable: true,
      professionalTaxMonthly: true,
      professionalTaxThreshold: true,
    },
  });

  return {
    providentFund: company.providentFundApplicable,
    employeeStateInsurance: company.esiApplicable,
    professionalTaxMonthly:
      company.professionalTaxMonthly === null
        ? null
        : Number(company.professionalTaxMonthly),
    professionalTaxThreshold:
      company.professionalTaxThreshold === null
        ? null
        : Number(company.professionalTaxThreshold),
  };
}

function serialise(result: StatutoryResult) {
  return {
    basicSalary: toStorageString(result.basicSalary),
    allowances: toStorageString(result.allowances),
    gross: toStorageString(result.gross),
    employeeProvidentFund: toStorageString(result.employeeProvidentFund),
    employeeStateInsurance: toStorageString(result.employeeStateInsurance),
    professionalTax: toStorageString(result.professionalTax),
    taxDeductedAtSource: toStorageString(result.taxDeductedAtSource),
    totalDeductions: toStorageString(result.totalDeductions),
    net: toStorageString(result.net),
    employerProvidentFund: toStorageString(result.employerProvidentFund),
    employerStateInsurance: toStorageString(result.employerStateInsurance),
    costToCompany: toStorageString(result.costToCompany),
  };
}

/**
 * What a run for this period would come to, without posting anything.
 *
 * Built from the employees on record at the moment it is asked, so it is a
 * proposal rather than a commitment — which is exactly what somebody about to
 * pay their staff wants to look at first.
 *
 * TDS is zero here for every employee. The platform does not compute it, and
 * showing a computed-looking zero without saying so would be worse than
 * showing nothing.
 */
export async function previewPayroll(params: {
  companyId: string;
  year: number;
  month: number;
  /** Per-employee TDS, entered by whoever runs the payroll. */
  taxDeducted?: Record<string, number>;
}): Promise<PayrollPreview> {
  const { companyId, year, month } = params;

  const [policy, employees, existing] = await Promise.all([
    payrollPolicy(companyId),
    prisma.employee.findMany({
      where: {
        companyId,
        status: { in: [...CURRENT_EMPLOYEE_STATUSES] },
        ...employedDuring(year, month),
      },
      select: {
        id: true,
        employeeCode: true,
        name: true,
        designation: true,
        basicSalary: true,
        allowances: true,
      },
      orderBy: { employeeCode: "asc" },
    }),
    // The same question `createPayrollRun` asks, asked the same way: a period
    // holding a cancelled run and its replacement must read as already run.
    prisma.payroll.findFirst({
      where: {
        companyId,
        periodYear: year,
        periodMonth: month,
        status: { not: PayrollStatus.CANCELLED },
      },
      select: { id: true },
    }),
  ]);

  const results = employees.map((employee) =>
    computeStatutory(
      {
        basicSalary: employee.basicSalary,
        allowances: employee.allowances,
        taxDeductedAtSource: params.taxDeducted?.[employee.id] ?? 0,
      },
      policy,
    ),
  );

  const notes = [
    "TDS is not calculated by this platform. It depends on the employee's projected annual income, the regime they elected and what they declared — enter it yourself, or leave it at nil.",
  ];
  if (!policy.providentFund) {
    notes.push(
      "Provident fund is switched off for this business, so no PF is deducted or contributed.",
    );
  }
  if (!policy.employeeStateInsurance) {
    notes.push("Employee state insurance is switched off for this business.");
  }
  if (policy.professionalTaxMonthly === null) {
    notes.push(
      "No professional tax is set. It is levied by the state and differs in each, so it is not guessed from your address.",
    );
  }

  return {
    periodYear: year,
    periodMonth: month,
    label: periodLabel(year, month),
    policy,
    payslips: employees.map((employee, index) => ({
      employeeId: employee.id,
      employeeCode: employee.employeeCode,
      name: employee.name,
      designation: employee.designation,
      ...serialise(results[index]!),
    })),
    totals: serialise(totalStatutory(results)),
    alreadyRun: existing !== null,
    notes,
  };
}

export type PostedPayroll = {
  id: string;
  reference: string;
  entryNumber: string;
  grossAmount: string;
  netAmount: string;
};

export async function createPayrollRun(params: {
  companyId: string;
  userId: string;
  actorEmail: string;
  branchId: string | null;
  year: number;
  month: number;
  payDate: string;
  taxDeducted?: Record<string, number>;
}): Promise<PostedPayroll> {
  const { companyId, year, month } = params;

  return prisma.$transaction(
    async (tx) => {
      const payDate = new Date(`${params.payDate}T00:00:00.000Z`);

      // Asked the way the index asks it: is there a *live* run for this month?
      //
      // It used to read any run for the period and then check whether that one
      // was cancelled, which is a different question once a period holds both —
      // a cancelled run and the one that replaced it. `findFirst` has no
      // ordering, so it could return the cancelled row, the guard would pass,
      // and the insert behind it would hit `payroll_one_live_run_per_period`.
      // The shopkeeper got a raw constraint error instead of the sentence this
      // exists to produce, on the third run of a month they had corrected once.
      const live = await tx.payroll.findFirst({
        where: {
          companyId,
          periodYear: year,
          periodMonth: month,
          status: { not: PayrollStatus.CANCELLED },
        },
        select: { id: true },
      });
      if (live) {
        // The index enforces one live run per period; this turns the constraint
        // into a sentence somebody can act on.
        throw new PayrollError(
          `Payroll for ${periodLabel(year, month)} has already been run.`,
          "ALREADY_RUN",
        );
      }

      const policy = await payrollPolicy(companyId);
      const employees = await tx.employee.findMany({
        where: {
          companyId,
          status: { in: [...CURRENT_EMPLOYEE_STATUSES] },
          ...employedDuring(year, month),
        },
        select: {
          id: true,
          basicSalary: true,
          allowances: true,
        },
        orderBy: { employeeCode: "asc" },
      });

      if (employees.length === 0) {
        throw new PayrollError(
          "There are no active employees to pay.",
          "NO_EMPLOYEES",
        );
      }

      const results = employees.map((employee) =>
        computeStatutory(
          {
            basicSalary: employee.basicSalary,
            allowances: employee.allowances,
            taxDeductedAtSource: params.taxDeducted?.[employee.id] ?? 0,
          },
          policy,
        ),
      );
      const totals = totalStatutory(results);

      if (isZero(totals.gross)) {
        throw new PayrollError(
          "Every active employee is on nil pay, so there is nothing to post.",
          "NOTHING_TO_PAY",
        );
      }

      const fiscalYear = await ensureFiscalYearFor(tx, {
        companyId,
        date: payDate,
      });

      const reference = await allocateDocumentNumber(tx, {
        companyId,
        key: "PAYROLL",
        fiscalYearId: fiscalYear.id,
      });

      const run = await tx.payroll.create({
        data: {
          companyId,
          reference,
          periodYear: year,
          periodMonth: month,
          payDate,
          status: PayrollStatus.APPROVED,
          grossAmount: toStorageString(totals.gross),
          deductionAmount: toStorageString(totals.totalDeductions),
          employerContributions: toStorageString(totals.employerContributions),
          netAmount: toStorageString(totals.net),
          createdById: params.userId,
          postedAt: new Date(),
          items: {
            create: employees.map((employee, index) => {
              const result = results[index]!;
              return {
                companyId,
                employeeId: employee.id,
                basicSalary: toStorageString(result.basicSalary),
                allowances: toStorageString(result.allowances),
                deductions: toStorageString(result.totalDeductions),
                employeeProvidentFund: toStorageString(
                  result.employeeProvidentFund,
                ),
                employeeStateInsurance: toStorageString(
                  result.employeeStateInsurance,
                ),
                professionalTax: toStorageString(result.professionalTax),
                taxDeductedAtSource: toStorageString(
                  result.taxDeductedAtSource,
                ),
                employerProvidentFund: toStorageString(
                  result.employerProvidentFund,
                ),
                employerStateInsurance: toStorageString(
                  result.employerStateInsurance,
                ),
                netSalary: toStorageString(result.net),
              };
            }),
          },
        },
        select: { id: true },
      });

      // --- The entry --------------------------------------------------------
      const accountId = await resolveSystemAccounts(tx, companyId, [
        SYSTEM_ACCOUNT.SALARY_EXPENSE,
        SYSTEM_ACCOUNT.EMPLOYER_CONTRIBUTIONS,
        SYSTEM_ACCOUNT.SALARY_PAYABLE,
        SYSTEM_ACCOUNT.PF_PAYABLE,
        SYSTEM_ACCOUNT.ESI_PAYABLE,
        SYSTEM_ACCOUNT.PROFESSIONAL_TAX_PAYABLE,
        SYSTEM_ACCOUNT.TDS_PAYABLE,
      ]);

      const lines: DraftJournalLine[] = [
        {
          accountId: accountId(SYSTEM_ACCOUNT.SALARY_EXPENSE),
          debit: totals.gross,
          narration: `Payroll for ${periodLabel(year, month)}`,
        },
      ];

      if (!isZero(totals.employerContributions)) {
        lines.push({
          accountId: accountId(SYSTEM_ACCOUNT.EMPLOYER_CONTRIBUTIONS),
          debit: totals.employerContributions,
          narration: "Employer PF and ESI",
        });
      }

      lines.push({
        accountId: accountId(SYSTEM_ACCOUNT.SALARY_PAYABLE),
        credit: totals.net,
        narration: "Net pay owed to staff",
      });

      // Employee and employer shares go to the same liability because they are
      // remitted to the same authority in one payment.
      const statutory: Array<[string, Decimal, string]> = [
        [
          SYSTEM_ACCOUNT.PF_PAYABLE,
          totals.employeeProvidentFund.plus(totals.employerProvidentFund),
          "Provident fund, both shares",
        ],
        [
          SYSTEM_ACCOUNT.ESI_PAYABLE,
          totals.employeeStateInsurance.plus(totals.employerStateInsurance),
          "Employee state insurance, both shares",
        ],
        [
          SYSTEM_ACCOUNT.PROFESSIONAL_TAX_PAYABLE,
          totals.professionalTax,
          "Professional tax withheld",
        ],
        [
          SYSTEM_ACCOUNT.TDS_PAYABLE,
          totals.taxDeductedAtSource,
          "Tax deducted at source",
        ],
      ];

      for (const [key, amount, narration] of statutory) {
        if (!isZero(amount)) {
          lines.push({ accountId: accountId(key), credit: amount, narration });
        }
      }

      const entry = await postJournalEntry(tx, {
        companyId,
        branchId: params.branchId,
        entryDate: payDate,
        voucherType: VoucherType.PAYROLL,
        narration: `Payroll ${reference} for ${periodLabel(year, month)}`,
        referenceNo: reference,
        sourceType: "Payroll",
        sourceId: run.id,
        createdById: params.userId,
        lines,
      });

      await tx.payroll.update({
        where: { id: run.id },
        data: { journalEntryId: entry.id },
      });

      await recordAuditLog(
        {
          action: "payroll.posted",
          module: "Payroll",
          companyId,
          userId: params.userId,
          actorEmail: params.actorEmail,
          entityType: "Payroll",
          entityId: run.id,
          metadata: {
            reference,
            period: periodLabel(year, month),
            employees: employees.length,
            gross: toStorageString(totals.gross),
            net: toStorageString(totals.net),
          },
        },
        tx,
      );

      return {
        id: run.id,
        reference,
        entryNumber: entry.entryNumber,
        grossAmount: toStorageString(totals.gross),
        netAmount: toStorageString(totals.net),
      };
    },
    { timeout: 30_000 },
  );
}

/** Every liability a run credits, so the void can check they are still there. */
const PAYROLL_LIABILITIES = [
  SYSTEM_ACCOUNT.SALARY_PAYABLE,
  SYSTEM_ACCOUNT.PF_PAYABLE,
  SYSTEM_ACCOUNT.ESI_PAYABLE,
  SYSTEM_ACCOUNT.PROFESSIONAL_TAX_PAYABLE,
  SYSTEM_ACCOUNT.TDS_PAYABLE,
] as const;

/**
 * Undoing a run.
 *
 * The last document in the product that could not be undone. Every other one —
 * an invoice, a bill, an expense, a receipt, a payment, a journal voucher — goes
 * through `reversePostedEntry`, and payroll went through nothing: once posted, a
 * month was permanent, and the period was closed to a second attempt for good by
 * the guard in `createPayrollRun`. A wrong pay date or a salary corrected after
 * the fact had no answer.
 *
 * The reversal is that same shared path, so what comes back out is what went in,
 * line for line, whatever the rates were that month. The run is marked cancelled
 * rather than deleted: its reference, its payslips and its entry all stay
 * readable, which is what makes the correction explicable afterwards.
 *
 * **What it refuses.** A run's five liabilities can be settled — staff paid, the
 * challans remitted — and once they have been, reversing the entry would drive
 * those accounts below nil: the debt is gone and the credit that created it
 * would be taken back anyway. There is no allocation tying a payment to a run,
 * so the question this can actually answer is whether each account still holds
 * what this run put into it. Where one does not, the void is refused and says
 * which, in the same terms `voidPurchase` refuses a bill whose stock has been
 * sold on.
 */
export async function voidPayroll(params: {
  companyId: string;
  payrollId: string;
  userId: string;
  actorEmail: string;
  reason: string;
}): Promise<{ reference: string; entryNumber: string }> {
  return prisma.$transaction(
    async (tx) => {
      const run = await tx.payroll.findFirst({
        where: { id: params.payrollId, companyId: params.companyId },
        select: {
          id: true,
          reference: true,
          payDate: true,
          periodYear: true,
          periodMonth: true,
          status: true,
          journalEntryId: true,
        },
      });

      if (!run) {
        throw new PayrollError(
          "That payroll run could not be found.",
          "NOT_FOUND",
        );
      }
      if (run.status === PayrollStatus.CANCELLED) {
        throw new PayrollError(
          `${run.reference} has already been cancelled.`,
          "ALREADY_CANCELLED",
        );
      }
      const entryId = run.journalEntryId;
      if (!entryId) {
        throw new PayrollError(
          "This run has no journal entry to reverse, so it cannot be cancelled safely.",
          "NO_ENTRY",
        );
      }

      // --- Are the debts it created still on the books? ---------------------
      const accountId = await resolveSystemAccounts(tx, params.companyId, [
        ...PAYROLL_LIABILITIES,
      ]);

      for (const key of PAYROLL_LIABILITIES) {
        const account = accountId(key);
        const [owedNow, credited] = await Promise.all([
          balanceOf(tx, params.companyId, account),
          creditedByEntry(tx, params.companyId, entryId, account),
        ]);

        // Liabilities sit as credit balances, so both figures are negative here
        // and "still holds it" means the account owes at least what the run put
        // on it.
        if (compare(credited, 0) < 0 && compare(owedNow, credited) > 0) {
          throw new PayrollError(
            `${run.reference} put ${credited.abs().toFixed(2)} onto ${label(key)} and only ${owedNow.abs().toFixed(2)} is still owed on it — some of this run has already been paid over. Cancelling would take back a debt that is no longer there.`,
            "ALREADY_SETTLED",
          );
        }
      }

      const reversal = await reversePostedEntry(tx, {
        companyId: params.companyId,
        entryId,
        branchId: null,
        entryDate: run.payDate,
        voucherType: VoucherType.PAYROLL,
        narration: `Cancellation of payroll ${run.reference} — ${params.reason}`,
        referenceNo: run.reference,
        sourceType: "Payroll",
        sourceId: run.id,
        createdById: params.userId,
      });

      await tx.payroll.update({
        where: { id: run.id },
        data: { status: PayrollStatus.CANCELLED },
      });

      await recordAuditLog(
        {
          action: "payroll.cancelled",
          module: "Payroll",
          companyId: params.companyId,
          userId: params.userId,
          actorEmail: params.actorEmail,
          entityType: "Payroll",
          entityId: run.id,
          metadata: {
            reference: run.reference,
            period: periodLabel(run.periodYear, run.periodMonth),
            reason: params.reason,
            reversalEntry: reversal.entryNumber,
          },
        },
        tx,
      );

      return { reference: run.reference, entryNumber: reversal.entryNumber };
    },
    { timeout: 30_000 },
  );
}

/** Net movement on one account, as at now. */
async function balanceOf(
  tx: Parameters<typeof postJournalEntry>[0],
  companyId: string,
  accountId: string,
): Promise<Decimal> {
  const totals = await tx.journalLine.aggregate({
    where: { companyId, accountId, status: "POSTED" },
    _sum: { debit: true, credit: true },
  });
  return subtract(totals._sum.debit ?? 0, totals._sum.credit ?? 0);
}

/** What one entry put onto one account, net. */
async function creditedByEntry(
  tx: Parameters<typeof postJournalEntry>[0],
  companyId: string,
  journalEntryId: string,
  accountId: string,
): Promise<Decimal> {
  const totals = await tx.journalLine.aggregate({
    where: { companyId, journalEntryId, accountId },
    _sum: { debit: true, credit: true },
  });
  return subtract(totals._sum.debit ?? 0, totals._sum.credit ?? 0);
}

/** The account's name in the sentence a refusal produces. */
function label(systemKey: string): string {
  return systemKey.toLowerCase().replace(/_/g, " ");
}

export type PayrollRunRow = {
  id: string;
  reference: string;
  label: string;
  payDate: Date;
  status: PayrollStatus;
  employees: number;
  grossAmount: string;
  deductionAmount: string;
  netAmount: string;
};

export async function listPayrollRuns(
  companyId: string,
): Promise<PayrollRunRow[]> {
  const runs = await prisma.payroll.findMany({
    where: { companyId },
    select: {
      id: true,
      reference: true,
      periodYear: true,
      periodMonth: true,
      payDate: true,
      status: true,
      grossAmount: true,
      deductionAmount: true,
      netAmount: true,
      _count: { select: { items: true } },
    },
    orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }],
  });

  return runs.map((run) => ({
    id: run.id,
    reference: run.reference,
    label: periodLabel(run.periodYear, run.periodMonth),
    payDate: run.payDate,
    status: run.status,
    employees: run._count.items,
    grossAmount: toStorageString(run.grossAmount),
    deductionAmount: toStorageString(run.deductionAmount),
    netAmount: toStorageString(run.netAmount),
  }));
}

export async function getPayrollRun(params: { companyId: string; id: string }) {
  const run = await prisma.payroll.findFirst({
    where: { id: params.id, companyId: params.companyId },
    select: {
      id: true,
      reference: true,
      periodYear: true,
      periodMonth: true,
      payDate: true,
      status: true,
      grossAmount: true,
      deductionAmount: true,
      employerContributions: true,
      netAmount: true,
      journalEntryId: true,
      items: {
        select: {
          basicSalary: true,
          allowances: true,
          deductions: true,
          employeeProvidentFund: true,
          employeeStateInsurance: true,
          professionalTax: true,
          taxDeductedAtSource: true,
          employerProvidentFund: true,
          employerStateInsurance: true,
          netSalary: true,
          employee: {
            select: { employeeCode: true, name: true, designation: true },
          },
        },
        orderBy: { employee: { employeeCode: "asc" } },
      },
    },
  });

  if (!run) {
    throw new PayrollError("That payroll run could not be found.", "NOT_FOUND");
  }

  const entry = run.journalEntryId
    ? await prisma.journalEntry.findFirst({
        where: { id: run.journalEntryId, companyId: params.companyId },
        select: {
          entryNumber: true,
          status: true,
          totalDebit: true,
          lines: {
            select: {
              lineNumber: true,
              debit: true,
              credit: true,
              narration: true,
              account: { select: { code: true, name: true } },
            },
            orderBy: { lineNumber: "asc" },
          },
        },
      })
    : null;

  return { run, entry, label: periodLabel(run.periodYear, run.periodMonth) };
}
