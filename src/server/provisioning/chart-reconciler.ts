import {
  DEFAULT_ACCOUNTS,
  DEFAULT_ACCOUNT_GROUPS,
} from "@/lib/accounting/chart-of-accounts";
import type { DbClient } from "@/lib/db";

/**
 * Gives every existing company the system accounts added since it signed up.
 *
 * The chart is copied from a static definition at provisioning and, until
 * this, was never revisited. That is not a dormant tidiness problem: the
 * payroll release added `PF_PAYABLE`, `ESI_PAYABLE`,
 * `PROFESSIONAL_TAX_PAYABLE` and `EMPLOYER_CONTRIBUTIONS`, and posting a
 * payroll run resolves all four through `resolveSystemAccounts`, which throws
 * `MissingAccountError` when one is absent. Every business that signed up
 * before that release could open the payroll screen, fill it in, and be unable
 * to post — with nothing they or an administrator could do about it from
 * inside the product.
 *
 * **Add-only, unlike the role sync.** A role's permissions are a set the
 * tenant cannot edit, so making them match the template exactly is right. An
 * account is not: it carries a balance and may be posted against, tenants
 * create their own, and a "delete what the template lacks" pass over the chart
 * of accounts is how a business loses its ledger. Anything unexpected here is
 * left alone and reported rather than removed.
 *
 * Groups are reconciled too, because an account added in a later release can
 * sit under a group that did not exist either.
 */
export async function reconcileCompanyChart(
  tx: DbClient,
  companyId: string,
): Promise<{ groups: number; accounts: number }> {
  const existingGroups = await tx.accountGroup.findMany({
    where: { companyId },
    select: { id: true, code: true },
  });
  const groupIdsByCode = new Map(
    existingGroups.map((group) => [group.code, group.id]),
  );

  let groupsAdded = 0;
  // Parents before children, the same shape as provisioning: a group added in
  // a later release may hang off another group added in the same release.
  const missingGroups = DEFAULT_ACCOUNT_GROUPS.filter(
    (group) => !groupIdsByCode.has(group.code),
  );
  let guard = 0;
  const remaining = [...missingGroups];
  while (remaining.length > 0 && guard < 10) {
    guard += 1;
    const insertable = remaining.filter(
      (group) => !group.parentCode || groupIdsByCode.has(group.parentCode),
    );
    if (insertable.length === 0) {
      throw new Error(
        `Chart reconciliation cannot place groups: ${remaining
          .map((group) => group.code)
          .join(", ")}`,
      );
    }

    for (const group of insertable) {
      const created = await tx.accountGroup.create({
        data: {
          companyId,
          parentId: group.parentCode
            ? (groupIdsByCode.get(group.parentCode) ?? null)
            : null,
          code: group.code,
          name: group.name,
          type: group.type,
          nature: group.nature,
          section: group.section,
          sortOrder: group.sortOrder,
          isSystem: true,
        },
        select: { id: true },
      });
      groupIdsByCode.set(group.code, created.id);
      groupsAdded += 1;
      remaining.splice(remaining.indexOf(group), 1);
    }
  }

  // Matched on `systemKey`, not on code. The code is what a business sees and
  // could in principle collide with one of their own; the system key is what
  // the posting code actually asks for, and it is the thing whose absence
  // breaks a journal entry.
  const existingAccounts = await tx.account.findMany({
    where: { companyId },
    select: { systemKey: true, code: true },
  });
  const haveKeys = new Set(
    existingAccounts.flatMap((account) =>
      account.systemKey ? [account.systemKey] : [],
    ),
  );
  const haveCodes = new Set(existingAccounts.map((account) => account.code));

  const missingAccounts = DEFAULT_ACCOUNTS.filter(
    (account) => account.systemKey && !haveKeys.has(account.systemKey),
  );
  if (missingAccounts.length === 0) {
    return { groups: groupsAdded, accounts: 0 };
  }

  for (const account of missingAccounts) {
    const groupId = groupIdsByCode.get(account.groupCode);
    if (!groupId) {
      throw new Error(
        `Account ${account.code} references unknown group ${account.groupCode}`,
      );
    }

    // A tenant may already hold this code on an account of their own, since
    // the standard chart grows into numbers that were free when they signed
    // up. Their row is not touched; the system account takes the next number
    // in the same block so both can exist.
    let code = account.code;
    if (haveCodes.has(code)) {
      let suffix = 1;
      while (haveCodes.has(`${account.code}-${suffix}`)) suffix += 1;
      code = `${account.code}-${suffix}`;
    }
    haveCodes.add(code);

    await tx.account.create({
      data: {
        companyId,
        groupId,
        code,
        name: account.name,
        type: account.type,
        subType: account.subType,
        nature: account.nature,
        section: account.section,
        systemKey: account.systemKey ?? null,
        description: account.description ?? null,
        partyType: account.partyType ?? null,
        isSystem: true,
        // Zero, and deliberately not derived from anything. This account did
        // not exist while the business was trading, so it has no history to
        // carry — an opening balance here would be an invention.
        openingBalance: 0,
        openingNature: account.nature,
      },
      select: { id: true },
    });
  }

  return { groups: groupsAdded, accounts: missingAccounts.length };
}
