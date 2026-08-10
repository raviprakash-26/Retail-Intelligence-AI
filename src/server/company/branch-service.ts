import "server-only";
import { prisma } from "@/lib/db";
import { findStateByCode } from "@/lib/constants/india";
import type { BranchInput } from "@/lib/validation/company";
import { recordAuditLog } from "@/server/audit/audit-log";
import { TeamOperationError } from "./team-service";

/**
 * Branches.
 *
 * A branch is a posting location, not a folder. Once a transaction references
 * one it can be deactivated but never deleted — removing it would orphan the
 * journal entries and stock movements that name it, and an accounting record
 * that cannot say where it happened is not much of a record.
 */

export const BRANCH_AUDIT = {
  CREATED: "branch.created",
  UPDATED: "branch.updated",
  DEACTIVATED: "branch.deactivated",
  REACTIVATED: "branch.reactivated",
  PRIMARY_CHANGED: "branch.primary_changed",
} as const;

export type BranchSummary = {
  id: string;
  code: string;
  name: string;
  city: string | null;
  isPrimary: boolean;
  isActive: boolean;
  /** Documents referencing this branch; non-zero means it cannot be deleted. */
  activityCount: number;
  memberCount: number;
};

export async function listBranches(
  companyId: string,
): Promise<BranchSummary[]> {
  const branches = await prisma.branch.findMany({
    where: { companyId },
    select: {
      id: true,
      code: true,
      name: true,
      city: true,
      isPrimary: true,
      isActive: true,
      _count: {
        select: {
          journalEntries: true,
          sales: true,
          purchases: true,
          expenses: true,
          memberships: true,
        },
      },
    },
    orderBy: [{ isPrimary: "desc" }, { code: "asc" }],
  });

  return branches.map((branch) => ({
    id: branch.id,
    code: branch.code,
    name: branch.name,
    city: branch.city,
    isPrimary: branch.isPrimary,
    isActive: branch.isActive,
    activityCount:
      branch._count.journalEntries +
      branch._count.sales +
      branch._count.purchases +
      branch._count.expenses,
    memberCount: branch._count.memberships,
  }));
}

export async function createBranch(params: {
  companyId: string;
  userId: string;
  actorEmail: string;
  input: BranchInput;
}): Promise<{ id: string }> {
  const { companyId, input } = params;

  const duplicate = await prisma.branch.findUnique({
    where: { companyId_code: { companyId, code: input.code } },
    select: { id: true },
  });
  if (duplicate) {
    throw new TeamOperationError(
      `A branch with the code ${input.code} already exists.`,
      "DUPLICATE_CODE",
      "code",
    );
  }

  const branch = await prisma.branch.create({
    data: {
      companyId,
      code: input.code,
      name: input.name,
      addressLine1: input.addressLine1 || null,
      city: input.city || null,
      state: input.stateCode
        ? (findStateByCode(input.stateCode)?.name ?? null)
        : null,
      stateCode: input.stateCode || null,
      pincode: input.pincode || null,
      phone: input.phone || null,
      // The first branch of a company is created by provisioning, so anything
      // added here is a secondary location.
      isPrimary: false,
    },
    select: { id: true },
  });

  await recordAuditLog({
    action: BRANCH_AUDIT.CREATED,
    module: "Settings",
    companyId,
    userId: params.userId,
    actorEmail: params.actorEmail,
    entityType: "Branch",
    entityId: branch.id,
    metadata: { code: input.code, name: input.name },
  });

  return branch;
}

export async function updateBranch(params: {
  companyId: string;
  branchId: string;
  userId: string;
  actorEmail: string;
  input: BranchInput;
}): Promise<void> {
  const { companyId, branchId, input } = params;

  const branch = await prisma.branch.findFirst({
    where: { id: branchId, companyId },
    select: { id: true, code: true },
  });
  if (!branch) {
    throw new TeamOperationError(
      "That branch could not be found.",
      "NOT_FOUND",
    );
  }

  if (branch.code !== input.code) {
    const duplicate = await prisma.branch.findUnique({
      where: { companyId_code: { companyId, code: input.code } },
      select: { id: true },
    });
    if (duplicate) {
      throw new TeamOperationError(
        `A branch with the code ${input.code} already exists.`,
        "DUPLICATE_CODE",
        "code",
      );
    }
  }

  await prisma.branch.update({
    where: { id: branchId },
    data: {
      code: input.code,
      name: input.name,
      addressLine1: input.addressLine1 || null,
      city: input.city || null,
      state: input.stateCode
        ? (findStateByCode(input.stateCode)?.name ?? null)
        : null,
      stateCode: input.stateCode || null,
      pincode: input.pincode || null,
      phone: input.phone || null,
    },
  });

  await recordAuditLog({
    action: BRANCH_AUDIT.UPDATED,
    module: "Settings",
    companyId,
    userId: params.userId,
    actorEmail: params.actorEmail,
    entityType: "Branch",
    entityId: branchId,
    metadata: { code: input.code, name: input.name },
  });
}

export async function setBranchActive(params: {
  companyId: string;
  branchId: string;
  isActive: boolean;
  userId: string;
  actorEmail: string;
}): Promise<void> {
  const branch = await prisma.branch.findFirst({
    where: { id: params.branchId, companyId: params.companyId },
    select: { id: true, code: true, isPrimary: true },
  });
  if (!branch) {
    throw new TeamOperationError(
      "That branch could not be found.",
      "NOT_FOUND",
    );
  }

  // The primary branch is where anything without an explicit location posts.
  // Closing it would leave the company with nowhere to record a transaction.
  if (branch.isPrimary && !params.isActive) {
    throw new TeamOperationError(
      "This is your primary branch. Make another branch primary before closing it.",
      "PRIMARY_BRANCH",
    );
  }

  await prisma.branch.update({
    where: { id: params.branchId },
    data: { isActive: params.isActive },
  });

  await recordAuditLog({
    action: params.isActive
      ? BRANCH_AUDIT.REACTIVATED
      : BRANCH_AUDIT.DEACTIVATED,
    module: "Settings",
    companyId: params.companyId,
    userId: params.userId,
    actorEmail: params.actorEmail,
    entityType: "Branch",
    entityId: params.branchId,
    metadata: { code: branch.code },
  });
}

export async function setPrimaryBranch(params: {
  companyId: string;
  branchId: string;
  userId: string;
  actorEmail: string;
}): Promise<void> {
  const branch = await prisma.branch.findFirst({
    where: { id: params.branchId, companyId: params.companyId },
    select: { id: true, code: true, isActive: true },
  });
  if (!branch) {
    throw new TeamOperationError(
      "That branch could not be found.",
      "NOT_FOUND",
    );
  }
  if (!branch.isActive) {
    throw new TeamOperationError(
      "Reopen this branch before making it primary.",
      "BRANCH_INACTIVE",
    );
  }

  // A partial unique index allows only one primary branch per company, so the
  // old one must be cleared and the new one set inside a single transaction.
  await prisma.$transaction(async (tx) => {
    await tx.branch.updateMany({
      where: { companyId: params.companyId, isPrimary: true },
      data: { isPrimary: false },
    });
    await tx.branch.update({
      where: { id: params.branchId },
      data: { isPrimary: true },
    });
  });

  await recordAuditLog({
    action: BRANCH_AUDIT.PRIMARY_CHANGED,
    module: "Settings",
    companyId: params.companyId,
    userId: params.userId,
    actorEmail: params.actorEmail,
    entityType: "Branch",
    entityId: params.branchId,
    metadata: { code: branch.code },
  });
}
