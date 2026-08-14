import "server-only";
import type { DbClient } from "@/lib/db";

/**
 * Resolving the ledger accounts a document posts to.
 *
 * Accounts are found by `systemKey`, never by name or code, so a retailer who
 * renames "Cash" to "Counter Cash" or renumbers their chart does not silently
 * break posting. Missing an account is a configuration fault the caller has to
 * report, not something to paper over with a null.
 */

export class MissingAccountError extends Error {
  constructor(readonly systemKey: string) {
    super(
      `The ${systemKey.toLowerCase().replace(/_/g, " ")} account is missing from your chart of accounts.`,
    );
    this.name = "MissingAccountError";
  }
}

export type AccountLookup = (systemKey: string) => string;

/**
 * Loads every account a document needs in one query and returns a lookup.
 *
 * Fetching them together rather than one at a time matters: posting a bill
 * touches six or seven accounts, and a round trip each would put the slowest
 * part of the transaction inside the lock the document number is holding.
 */
export async function resolveSystemAccounts(
  tx: DbClient,
  companyId: string,
  keys: readonly string[],
): Promise<AccountLookup> {
  const accounts = await tx.account.findMany({
    where: { companyId, systemKey: { in: [...keys] } },
    select: { id: true, systemKey: true },
  });

  const map = new Map<string, string>();
  for (const account of accounts) {
    if (account.systemKey) map.set(account.systemKey, account.id);
  }

  for (const key of keys) {
    if (!map.has(key)) throw new MissingAccountError(key);
  }

  return (systemKey: string) => {
    const id = map.get(systemKey);
    if (!id) throw new MissingAccountError(systemKey);
    return id;
  };
}
