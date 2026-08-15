import "server-only";
import { AccountSubType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { toStorageString } from "@/lib/money";
import type { BankAccountValues } from "@/lib/validation/banking";

/**
 * The bank accounts a company keeps, and the ledger accounts behind them.
 *
 * A bank account here is a *description* of a real account — its name, the
 * branch, the last digits somebody recognises — bolted to exactly one ledger
 * account. The ledger account is where the money actually lives; this record
 * exists so a statement can be imported against something more specific than
 * "Bank", and so a business with two current accounts can reconcile them
 * separately.
 */

export class BankAccountError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "BankAccountError";
  }
}

export type BankAccountSummary = {
  id: string;
  name: string;
  bankName: string | null;
  accountNumber: string | null;
  ifsc: string | null;
  branchName: string | null;
  type: string;
  accountId: string;
  accountName: string;
  accountCode: string;
  isActive: boolean;
  /** How many imported statement lines are still unmatched. */
  unreconciledCount: number;
};

/**
 * The last four digits, and nothing else.
 *
 * A full account number is not needed to tell two accounts apart on a screen,
 * and a page that prints it in full is a page somebody will screenshot.
 */
export function maskAccountNumber(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\s/g, "");
  if (digits.length <= 4) return digits;
  return `••••${digits.slice(-4)}`;
}

export async function listBankAccounts(
  companyId: string,
): Promise<BankAccountSummary[]> {
  const accounts = await prisma.bankAccount.findMany({
    where: { companyId },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      bankName: true,
      accountNumber: true,
      ifsc: true,
      branchName: true,
      type: true,
      accountId: true,
      isActive: true,
      account: { select: { name: true, code: true } },
      _count: { select: { transactions: { where: { reconciledAt: null } } } },
    },
  });

  return accounts.map((account) => ({
    id: account.id,
    name: account.name,
    bankName: account.bankName,
    accountNumber: maskAccountNumber(account.accountNumber),
    ifsc: account.ifsc,
    branchName: account.branchName,
    type: account.type,
    accountId: account.accountId,
    accountName: account.account.name,
    accountCode: account.account.code,
    isActive: account.isActive,
    unreconciledCount: account._count.transactions,
  }));
}

/**
 * Ledger accounts a bank account may point at.
 *
 * Restricted to cash-and-bank asset accounts: pointing a bank account at Sales
 * would make every reconciliation nonsense, and the constraint belongs on the
 * server rather than in the shape of a dropdown.
 */
export async function bankableAccounts(
  companyId: string,
): Promise<{ id: string; name: string; code: string; alreadyUsed: boolean }[]> {
  const [accounts, used] = await Promise.all([
    prisma.account.findMany({
      where: {
        companyId,
        isActive: true,
        subType: AccountSubType.CASH_AND_BANK,
      },
      orderBy: { code: "asc" },
      select: { id: true, name: true, code: true },
    }),
    prisma.bankAccount.findMany({
      where: { companyId },
      select: { accountId: true },
    }),
  ]);

  const usedIds = new Set(used.map((entry) => entry.accountId));
  return accounts.map((account) => ({
    ...account,
    alreadyUsed: usedIds.has(account.id),
  }));
}

export async function createBankAccount(params: {
  companyId: string;
  input: BankAccountValues;
}): Promise<{ id: string; name: string }> {
  const { companyId, input } = params;

  // The ledger account must belong to this company and be a cash-and-bank
  // account. Both checks are here rather than in the form: an id in a request
  // body is not evidence of anything.
  const account = await prisma.account.findFirst({
    where: { id: input.accountId, companyId },
    select: { id: true, subType: true, isActive: true },
  });
  if (!account) {
    throw new BankAccountError(
      "That ledger account does not belong to this business.",
      "NOT_FOUND",
      "accountId",
    );
  }
  if (account.subType !== AccountSubType.CASH_AND_BANK) {
    throw new BankAccountError(
      "A bank account has to point at a cash and bank account in your chart.",
      "WRONG_ACCOUNT_TYPE",
      "accountId",
    );
  }

  const duplicateName = await prisma.bankAccount.findFirst({
    where: { companyId, name: input.name },
    select: { id: true },
  });
  if (duplicateName) {
    throw new BankAccountError(
      "You already have a bank account with that name.",
      "DUPLICATE",
      "name",
    );
  }

  // Two bank accounts sharing one ledger account would make each
  // reconciliation include the other's movements, and every figure on both
  // pages would be wrong in a way that is very hard to see.
  const duplicateAccount = await prisma.bankAccount.findFirst({
    where: { companyId, accountId: input.accountId },
    select: { name: true },
  });
  if (duplicateAccount) {
    throw new BankAccountError(
      `That ledger account is already used by "${duplicateAccount.name}". Two bank accounts cannot share one ledger account.`,
      "DUPLICATE_LEDGER_ACCOUNT",
      "accountId",
    );
  }

  const created = await prisma.bankAccount.create({
    data: {
      companyId,
      accountId: input.accountId,
      name: input.name,
      bankName: input.bankName ?? null,
      accountNumber: input.accountNumber ?? null,
      ifsc: input.ifsc?.toUpperCase() ?? null,
      branchName: input.branchName ?? null,
      type: input.type,
      // The opening balance belongs to the ledger account, which already has
      // one from the opening-balance entry. Recording a second here would give
      // the reconciliation two different starting points to choose between.
      openingBalance: toStorageString(0),
    },
    select: { id: true, name: true },
  });

  return created;
}

/** One bank account, scoped to the company asking. */
export async function getBankAccount(params: {
  companyId: string;
  bankAccountId: string;
}): Promise<{
  id: string;
  name: string;
  accountId: string;
  accountName: string;
  bankName: string | null;
  accountNumber: string | null;
} | null> {
  const account = await prisma.bankAccount.findFirst({
    where: { id: params.bankAccountId, companyId: params.companyId },
    select: {
      id: true,
      name: true,
      accountId: true,
      bankName: true,
      accountNumber: true,
      account: { select: { name: true } },
    },
  });
  if (!account) return null;
  return {
    id: account.id,
    name: account.name,
    accountId: account.accountId,
    accountName: account.account.name,
    bankName: account.bankName,
    accountNumber: maskAccountNumber(account.accountNumber),
  };
}
