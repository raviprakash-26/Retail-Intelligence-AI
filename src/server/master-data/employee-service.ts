import "server-only";
import { EmployeeStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { add, toStorageString } from "@/lib/money";
import type { EmployeeInput } from "@/lib/validation/master-data";
import { recordAuditLog } from "@/server/audit/audit-log";
import { MasterDataError } from "./errors";
import { allocateMasterCode } from "./master-code";

/**
 * Employees.
 *
 * A staff record on its own posts nothing. Salary becomes an expense when a
 * payroll run is posted, not when someone is hired — so the figures held here
 * are the terms of employment, and the ledger stays silent until there is a
 * period to pay for. The status field is what payroll will read to decide who
 * is owed anything.
 */

export const EMPLOYEE_AUDIT = {
  CREATED: "employee.created",
  UPDATED: "employee.updated",
  STATUS_CHANGED: "employee.status_changed",
} as const;

export const EMPLOYEE_PAGE_SIZE = 25;

export type EmployeeRow = {
  id: string;
  employeeCode: string;
  name: string;
  email: string | null;
  phone: string | null;
  department: string | null;
  designation: string | null;
  joiningDate: string;
  exitDate: string | null;
  status: EmployeeStatus;
  basicSalary: string;
  allowances: string;
  grossSalary: string;
  panNumber: string | null;
  bankAccountNo: string | null;
  ifsc: string | null;
};

export type EmployeeListResult = {
  rows: EmployeeRow[];
  total: number;
  page: number;
  pageCount: number;
  /** Monthly cost of everyone currently on the books, for the page header. */
  activeMonthlyCost: string;
};

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Still on the staff, as against a former employee.
 *
 * Somebody on leave has not left. `includeFormer` has to be asked for before
 * they are hidden from the list, which is right — maternity leave, medical
 * leave and a sabbatical are all employment.
 *
 * Exported because payroll has to mean the same thing by it. It did not: the
 * run selected on ACTIVE alone, so an employee on leave was on the staff list
 * and absent from the payroll — no payslip, no salary posted, nothing said.
 * One definition, in one place, is what stops the two drifting apart again.
 */
export const CURRENT_EMPLOYEE_STATUSES: readonly EmployeeStatus[] = [
  EmployeeStatus.ACTIVE,
  EmployeeStatus.ON_LEAVE,
];

export async function listEmployees(params: {
  companyId: string;
  query?: string;
  includeFormer?: boolean;
  page?: number;
}): Promise<EmployeeListResult> {
  const page = Math.max(1, params.page ?? 1);
  const query = params.query?.trim() ?? "";

  const where: Prisma.EmployeeWhereInput = {
    companyId: params.companyId,
    ...(params.includeFormer
      ? {}
      : { status: { in: [...CURRENT_EMPLOYEE_STATUSES] } }),
    ...(query.length >= 1
      ? {
          OR: [
            { name: { contains: query, mode: Prisma.QueryMode.insensitive } },
            {
              employeeCode: {
                contains: query,
                mode: Prisma.QueryMode.insensitive,
              },
            },
            {
              designation: {
                contains: query,
                mode: Prisma.QueryMode.insensitive,
              },
            },
            { phone: { contains: query } },
          ],
        }
      : {}),
  };

  const [total, employees, active] = await Promise.all([
    prisma.employee.count({ where }),
    prisma.employee.findMany({
      where,
      select: {
        id: true,
        employeeCode: true,
        name: true,
        email: true,
        phone: true,
        department: true,
        designation: true,
        joiningDate: true,
        exitDate: true,
        status: true,
        basicSalary: true,
        allowances: true,
        panNumber: true,
        bankAccountNo: true,
        ifsc: true,
      },
      orderBy: [{ status: "asc" }, { name: "asc" }],
      skip: (page - 1) * EMPLOYEE_PAGE_SIZE,
      take: EMPLOYEE_PAGE_SIZE,
    }),
    prisma.employee.aggregate({
      where: {
        companyId: params.companyId,
        status: { in: [...CURRENT_EMPLOYEE_STATUSES] },
      },
      _sum: { basicSalary: true, allowances: true },
    }),
  ]);

  return {
    rows: employees.map((employee) => ({
      id: employee.id,
      employeeCode: employee.employeeCode,
      name: employee.name,
      email: employee.email,
      phone: employee.phone,
      department: employee.department,
      designation: employee.designation,
      joiningDate: isoDay(employee.joiningDate),
      exitDate: employee.exitDate ? isoDay(employee.exitDate) : null,
      status: employee.status,
      basicSalary: toStorageString(employee.basicSalary),
      allowances: toStorageString(employee.allowances),
      grossSalary: toStorageString(
        add(employee.basicSalary, employee.allowances),
      ),
      panNumber: employee.panNumber,
      bankAccountNo: employee.bankAccountNo,
      ifsc: employee.ifsc,
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / EMPLOYEE_PAGE_SIZE)),
    activeMonthlyCost: toStorageString(
      add(active._sum.basicSalary ?? 0, active._sum.allowances ?? 0),
    ),
  };
}

/** Dates arrive as `YYYY-MM-DD` and are stored as dates, never as instants. */
function toDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function toRecordData(input: EmployeeInput) {
  return {
    name: input.name,
    email: input.email || null,
    phone: input.phone || null,
    department: input.department || null,
    designation: input.designation || null,
    joiningDate: toDate(input.joiningDate),
    exitDate: input.exitDate ? toDate(input.exitDate) : null,
    status: input.status,
    basicSalary: toStorageString(input.basicSalary),
    allowances: toStorageString(input.allowances),
    panNumber: input.panNumber || null,
    bankAccountNo: input.bankAccountNo || null,
    ifsc: input.ifsc || null,
  };
}

export async function createEmployee(params: {
  companyId: string;
  userId: string;
  actorEmail: string;
  input: EmployeeInput;
}): Promise<{ id: string; employeeCode: string }> {
  return prisma.$transaction(async (tx) => {
    const employeeCode = await allocateMasterCode(tx, {
      companyId: params.companyId,
      key: "EMPLOYEE",
      isTaken: async (candidate) =>
        (await tx.employee.findFirst({
          where: { companyId: params.companyId, employeeCode: candidate },
          select: { id: true },
        })) !== null,
    });

    const employee = await tx.employee.create({
      data: {
        ...toRecordData(params.input),
        companyId: params.companyId,
        employeeCode,
      },
      select: { id: true, employeeCode: true },
    });

    await recordAuditLog(
      {
        action: EMPLOYEE_AUDIT.CREATED,
        module: "Employees",
        companyId: params.companyId,
        userId: params.userId,
        actorEmail: params.actorEmail,
        entityType: "Employee",
        entityId: employee.id,
        metadata: {
          employeeCode: employee.employeeCode,
          name: params.input.name,
          designation: params.input.designation || null,
        },
      },
      tx,
    );

    return employee;
  });
}

export async function updateEmployee(params: {
  companyId: string;
  employeeId: string;
  userId: string;
  actorEmail: string;
  input: EmployeeInput;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.employee.findFirst({
      where: { id: params.employeeId, companyId: params.companyId },
      select: { id: true, employeeCode: true, status: true },
    });
    if (!existing) {
      throw new MasterDataError(
        "That employee record could not be found.",
        "NOT_FOUND",
      );
    }

    await tx.employee.update({
      where: { id: params.employeeId },
      data: toRecordData(params.input),
    });

    await recordAuditLog(
      {
        action:
          existing.status === params.input.status
            ? EMPLOYEE_AUDIT.UPDATED
            : EMPLOYEE_AUDIT.STATUS_CHANGED,
        module: "Employees",
        companyId: params.companyId,
        userId: params.userId,
        actorEmail: params.actorEmail,
        entityType: "Employee",
        entityId: params.employeeId,
        metadata: {
          employeeCode: existing.employeeCode,
          name: params.input.name,
          from: existing.status,
          to: params.input.status,
        },
      },
      tx,
    );
  });
}
