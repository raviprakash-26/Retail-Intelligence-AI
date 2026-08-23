import "server-only";
import {
  type AccountNature,
  type AccountSubType,
  type AccountType,
  Prisma,
  StatementSection,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  buildAccountTree,
  type AccountTreeNode,
  type TreeGroup,
} from "@/lib/accounting/account-tree";
import { toStorageString } from "@/lib/money";
import {
  DEFAULT_SECTION,
  NATURAL_SIDE,
  SELECTABLE_SUBTYPES,
  TRADING_SUBTYPES,
  type AccountEditInput,
  type AccountInput,
  type AccountTypeInput,
} from "@/lib/validation/accounts";
import { recordAuditLog } from "@/server/audit/audit-log";
import { accountBalances, accountLineCount, listAccountMeta } from "./balances";

/**
 * The chart of accounts, as something a retailer can shape.
 *
 * Two commitments pull against each other here and both have to be kept.
 *
 * A shop with an unusual cost should be able to give it its own line, because
 * an expense buried in Miscellaneous is an expense nobody manages. So accounts
 * can be added, renamed and retired.
 *
 * And the engine has to keep working. Posting rules resolve accounts by
 * `systemKey`, never by name or code, so a system account can be renamed freely
 * — call Sales "Counter Takings" if that is the word used in the shop — but it
 * cannot be deleted or reclassified, because the code that posts to it would
 * then have nowhere to post.
 *
 * Retiring rather than deleting is the other half of that. An account that has
 * ever been posted to is part of the audit trail; removing it would orphan
 * every line that referenced it and silently change last year's figures.
 */

export const ACCOUNT_AUDIT = {
  CREATED: "account.created",
  UPDATED: "account.updated",
  DEACTIVATED: "account.deactivated",
  REACTIVATED: "account.reactivated",
} as const;

export class AccountError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "AccountError";
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type ChartAccount = {
  id: string;
  code: string;
  name: string;
  groupId: string;
  type: AccountType;
  subType: AccountSubType;
  nature: AccountNature;
  section: StatementSection;
  isSystem: boolean;
  isActive: boolean;
  systemKey: string | null;
  description: string | null;
  /** Signed, in the direction of the account's nature. */
  balance: string;
  /** Whether anything has ever been posted to it. */
  used: boolean;
};

export type ChartGroup = TreeGroup & {
  isSystem: boolean;
  section: StatementSection;
};

export type ChartOfAccounts = {
  tree: Array<AccountTreeNode<ChartAccount>>;
  groups: ChartGroup[];
  accounts: ChartAccount[];
  counts: { total: number; custom: number; inactive: number };
};

/**
 * The whole chart, with a balance against every account.
 *
 * Balances come from the same engine the trial balance and the statements read,
 * so the figure beside an account here is the figure it will carry everywhere
 * else. A chart of accounts screen that computes its own totals is a screen
 * that will eventually disagree with the balance sheet.
 */
export async function getChartOfAccounts(params: {
  companyId: string;
  asOf?: Date | null;
  includeInactive?: boolean;
}): Promise<ChartOfAccounts> {
  const [groups, balances, rawAccounts] = await Promise.all([
    prisma.accountGroup.findMany({
      where: { companyId: params.companyId },
      select: {
        id: true,
        code: true,
        name: true,
        type: true,
        parentId: true,
        sortOrder: true,
        isSystem: true,
        section: true,
      },
      orderBy: { sortOrder: "asc" },
    }),
    accountBalances({
      companyId: params.companyId,
      to: params.asOf ?? null,
    }),
    prisma.account.findMany({
      where: { companyId: params.companyId },
      select: { id: true, description: true },
    }),
  ]);

  const descriptions = new Map(
    rawAccounts.map((account) => [account.id, account.description]),
  );

  const accounts: ChartAccount[] = balances
    .filter((balance) => params.includeInactive || balance.isActive)
    .map((balance) => ({
      id: balance.id,
      code: balance.code,
      name: balance.name,
      groupId: balance.groupId,
      type: balance.type,
      subType: balance.subType,
      nature: balance.nature,
      section: balance.section,
      isSystem: balance.isSystem,
      isActive: balance.isActive,
      systemKey: balance.systemKey,
      description: descriptions.get(balance.id) ?? null,
      balance: toStorageString(balance.balance),
      used: balance.hasMovement,
    }));

  return {
    tree: buildAccountTree(groups, accounts),
    groups,
    accounts,
    counts: {
      total: balances.length,
      custom: balances.filter((balance) => !balance.isSystem).length,
      inactive: balances.filter((balance) => !balance.isActive).length,
    },
  };
}

/** Groups an account of this type may be filed under. */
export async function assignableGroups(params: {
  companyId: string;
  type: AccountTypeInput;
}): Promise<Array<{ id: string; code: string; name: string }>> {
  const groups = await prisma.accountGroup.findMany({
    where: { companyId: params.companyId, type: params.type as AccountType },
    select: { id: true, code: true, name: true, sortOrder: true },
    orderBy: { sortOrder: "asc" },
  });
  return groups.map(({ id, code, name }) => ({ id, code, name }));
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Whether a sub-type is one a person is allowed to choose for this type.
 *
 * Guarding here as well as in the schema is deliberate: the schema knows the
 * string is a sub-type, this knows it is a sub-type of the *right* type. An
 * asset filed as `SALES` would land on the wrong side of the balance sheet.
 */
function resolveSubType(
  type: AccountTypeInput,
  subType: string,
): AccountSubType {
  const permitted = SELECTABLE_SUBTYPES[type].some(
    (option) => option.value === subType,
  );
  if (!permitted) {
    throw new AccountError(
      "That is not a kind of account this type can be.",
      "INVALID_SUBTYPE",
      "subType",
    );
  }
  return subType as AccountSubType;
}

export async function createAccount(params: {
  companyId: string;
  userId: string;
  actorEmail: string;
  input: AccountInput;
}): Promise<{ id: string; code: string; name: string }> {
  const { companyId, input } = params;
  const type = input.type;
  const subType = resolveSubType(type, input.subType);
  const code = input.code.trim().toUpperCase();

  const group = await prisma.accountGroup.findFirst({
    where: { id: input.groupId, companyId },
    select: { id: true, type: true, name: true },
  });

  if (!group) {
    throw new AccountError(
      "That group could not be found.",
      "GROUP_NOT_FOUND",
      "groupId",
    );
  }
  // A liability filed under Assets would appear on the wrong half of the
  // balance sheet and quietly break the accounting equation.
  if (group.type !== (type as AccountType)) {
    throw new AccountError(
      `${group.name} holds ${group.type.toLowerCase()} accounts, not ${type.toLowerCase()} ones.`,
      "GROUP_TYPE_MISMATCH",
      "groupId",
    );
  }

  const existing = await prisma.account.findFirst({
    where: { companyId, code },
    select: { name: true },
  });
  if (existing) {
    throw new AccountError(
      `Code ${code} is already used by ${existing.name}.`,
      "DUPLICATE_CODE",
      "code",
    );
  }

  const section: StatementSection = TRADING_SUBTYPES.has(subType)
    ? StatementSection.TRADING
    : (DEFAULT_SECTION[type] as StatementSection);

  const account = await prisma.account.create({
    data: {
      companyId,
      groupId: group.id,
      code,
      name: input.name,
      type: type as AccountType,
      subType,
      nature: NATURAL_SIDE[type] as AccountNature,
      section,
      description: input.description || null,
      // Never a system account: nothing in the engine resolves to it, so
      // nothing breaks if it is later retired.
      isSystem: false,
      isActive: true,
    },
    select: { id: true, code: true, name: true },
  });

  await recordAuditLog({
    action: ACCOUNT_AUDIT.CREATED,
    module: "Accounting",
    companyId,
    userId: params.userId,
    actorEmail: params.actorEmail,
    entityType: "Account",
    entityId: account.id,
    metadata: { code: account.code, name: account.name, type, subType },
  });

  return account;
}

/**
 * Renaming an account, including a system one.
 *
 * The code, type and group are not editable. Renumbering an account that has
 * been posted to would change how last year's ledger prints; reclassifying one
 * would move historic figures between statements. Both are real operations an
 * accountant sometimes needs, and both belong behind a deliberate migration
 * rather than a text field on a dialog.
 */
export async function updateAccount(params: {
  companyId: string;
  accountId: string;
  userId: string;
  actorEmail: string;
  input: AccountEditInput;
}): Promise<{ id: string; name: string }> {
  const account = await prisma.account.findFirst({
    where: { id: params.accountId, companyId: params.companyId },
    select: { id: true, name: true, code: true, description: true },
  });

  if (!account) {
    throw new AccountError("That account could not be found.", "NOT_FOUND");
  }

  const updated = await prisma.account.update({
    where: { id: account.id },
    data: {
      name: params.input.name,
      description: params.input.description || null,
    },
    select: { id: true, name: true },
  });

  await recordAuditLog({
    action: ACCOUNT_AUDIT.UPDATED,
    module: "Accounting",
    companyId: params.companyId,
    userId: params.userId,
    actorEmail: params.actorEmail,
    entityType: "Account",
    entityId: account.id,
    metadata: {
      code: account.code,
      from: account.name,
      to: updated.name,
    },
  });

  return updated;
}

/**
 * Retiring an account.
 *
 * Never a delete. An account that has been posted to is part of the audit
 * trail, and the balance it carries has to keep appearing on the balance sheet
 * whether or not anyone intends to use it again — so retiring one that still
 * holds a balance is refused, with the balance named. Clear it first, usually
 * by a transfer entry, and then it can be put away.
 */
export async function setAccountActive(params: {
  companyId: string;
  accountId: string;
  userId: string;
  actorEmail: string;
  isActive: boolean;
}): Promise<{ id: string; name: string; isActive: boolean }> {
  const account = await prisma.account.findFirst({
    where: { id: params.accountId, companyId: params.companyId },
    select: {
      id: true,
      code: true,
      name: true,
      isSystem: true,
      isActive: true,
      systemKey: true,
    },
  });

  if (!account) {
    throw new AccountError("That account could not be found.", "NOT_FOUND");
  }
  if (account.isActive === params.isActive) {
    return { id: account.id, name: account.name, isActive: account.isActive };
  }

  if (!params.isActive) {
    if (account.isSystem) {
      throw new AccountError(
        `${account.name} is one of the accounts the system posts to automatically, so it has to stay available. You can rename it.`,
        "SYSTEM_ACCOUNT",
      );
    }

    const balance = (
      await accountBalances({
        companyId: params.companyId,
      })
    ).find((entry) => entry.id === account.id);

    if (balance && !balance.balance.isZero()) {
      throw new AccountError(
        `${account.name} still holds a balance of ${balance.balance.abs().toFixed(2)}. Clear it with a journal entry before putting the account away.`,
        "HAS_BALANCE",
      );
    }
  }

  const updated = await prisma.account.update({
    where: { id: account.id },
    data: { isActive: params.isActive },
    select: { id: true, name: true, isActive: true },
  });

  await recordAuditLog({
    action: params.isActive
      ? ACCOUNT_AUDIT.REACTIVATED
      : ACCOUNT_AUDIT.DEACTIVATED,
    module: "Accounting",
    companyId: params.companyId,
    userId: params.userId,
    actorEmail: params.actorEmail,
    entityType: "Account",
    entityId: account.id,
    metadata: { code: account.code, name: account.name },
  });

  return updated;
}

/**
 * What is known about one account, for its detail panel.
 *
 * The posting count is what tells someone whether retiring it is even possible,
 * so it is read here rather than being guessed at from the balance — an account
 * can have a hundred entries and net to zero.
 */
export async function getAccountDetail(params: {
  companyId: string;
  accountId: string;
}) {
  const meta = await listAccountMeta(params.companyId, {
    includeInactive: true,
  });

  const account = meta.find((entry) => entry.id === params.accountId);
  if (!account) {
    throw new AccountError("That account could not be found.", "NOT_FOUND");
  }

  const [lines, record] = await Promise.all([
    accountLineCount({
      companyId: params.companyId,
      accountId: params.accountId,
    }),
    prisma.account.findFirstOrThrow({
      where: { id: params.accountId, companyId: params.companyId },
      select: { description: true },
    }),
  ]);

  return { account, lines, description: record.description };
}

/** Prisma unique-violation on `accounts.code`, surfaced as a field error. */
export function isDuplicateAccountCode(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}
