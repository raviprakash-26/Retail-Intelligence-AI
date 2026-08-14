/**
 * What platform administration is allowed to look at.
 *
 * Somebody has to run this service: answer a support email, see why a tenant
 * cannot add a user, change what a plan costs, suspend an account that is
 * abusing it. None of that requires reading a shop's books, and this file draws
 * the line so that it is written down rather than assumed.
 *
 * **Operational metadata is visible. A tenant's own money is not.**
 *
 *   visible    how many invoices a business raised this month, how many users
 *              it has, which plan it is on, when it signed up, whether it is
 *              suspended, what it pays *us*
 *   not        what any of those invoices was for, who the customer was, what
 *              anything cost, what the shop is worth, what it earned
 *
 * The distinction is not squeamishness. A support engineer needs to know that a
 * tenant posted 400 transactions last month to answer "why am I being told I
 * have hit my limit". Nobody needs to know that one of them was ₹4,00,000 to
 * answer that, and a panel that shows it anyway turns every support request
 * into an unlogged disclosure of somebody's turnover.
 *
 * There is no impersonation in this build. If an administrator genuinely has to
 * see inside a tenant, a member of that tenant invites them the ordinary way,
 * which leaves a record on both sides that the tenant can see and revoke. A
 * "sign in as this customer" button that only the platform can see is exactly
 * the thing that gets used at three in the morning and explained afterwards.
 */

/**
 * Field names that carry a tenant's own money, whatever object they are on.
 *
 * Deliberately not including bare `total`: a list's row count is a total, a
 * tenant count is a total, and a guard that fires on every one of those gets
 * suppressed within a week. The specific compounds are here instead, and
 * `mentionsAmount` covers what a name-based rule cannot.
 */
export const TENANT_MONEY_FIELDS = [
  "amount",
  "amountMinor",
  "grandTotal",
  "totalValue",
  "lineTotal",
  "subTotal",
  "taxAmount",
  "revenue",
  "grossProfit",
  "netProfit",
  "balance",
  "closingBalance",
  "openingBalance",
  "debit",
  "credit",
  "stockValue",
  "outstanding",
  "overdue",
  "unitCost",
  "unitPrice",
  "sellingPrice",
  "purchasePrice",
  "turnover",
] as const;

/**
 * Whether an object carries a tenant's money anywhere inside it.
 *
 * Used by the tests that run against what the admin service actually returns
 * for a tenant with a full set of books, rather than against a description of
 * what it is supposed to return.
 *
 * `allow` exists for the platform's own figures — what a subscription costs is
 * the platform's revenue, not the tenant's, and refusing to show it would make
 * the panel useless for the one commercial question it exists to answer.
 */
export function findTenantMoney(
  value: unknown,
  options: { allow?: readonly string[] } = {},
  path = "",
): string | null {
  const allowed = new Set(options.allow ?? []);

  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const found = findTenantMoney(entry, options, `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }

  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const here = path ? `${path}.${key}` : key;
      if (
        !allowed.has(key) &&
        !allowed.has(here) &&
        (TENANT_MONEY_FIELDS as readonly string[]).includes(key)
      ) {
        return here;
      }
      const found = findTenantMoney(entry, options, here);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Whether a figure from a tenant's books appears anywhere in a payload.
 *
 * The name-based rule above catches a field called `revenue`; this catches the
 * same number arriving in a field called something else, which is the failure
 * that would actually get through review. Checked in the shapes money takes on
 * its way out — the raw number, two and four decimal places, and grouped with
 * separators.
 */
export function mentionsAmount(value: unknown, amount: number): boolean {
  const serialised = JSON.stringify(value) ?? "";
  const forms = [
    String(amount),
    amount.toFixed(2),
    amount.toFixed(4),
    amount.toLocaleString("en-IN"),
    amount.toLocaleString("en-US"),
  ];
  return forms.some((form) => serialised.includes(form));
}

/** Said on the panel itself, so the limit is visible to whoever is using it. */
export const ADMIN_SCOPE_NOTE =
  "This panel shows how each business uses the service — plan, allowances, counts, status. It does not show what any business sold, bought, owes or earned. Those books belong to them, and reading them is not something running this platform requires.";

export const NO_IMPERSONATION_NOTE =
  "There is no way to sign in as a customer from here. If you need to see inside an account, ask them to invite you: it leaves a record they can see and withdraw.";
