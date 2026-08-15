import type { Metadata } from "next";
import Link from "next/link";
import { MasterDataHeader } from "@/components/master-data/page-header";
import { AddBankAccountDialog } from "@/components/banking/add-bank-account-dialog";
import { requirePermission } from "@/server/auth/context";
import {
  bankableAccounts,
  listBankAccounts,
} from "@/server/banking/bank-account-service";
import { BANK_ACCOUNT_TYPE_LABELS } from "@/lib/validation/banking";

export const metadata: Metadata = {
  title: "Bank reconciliation",
  robots: { index: false, follow: false },
};

/**
 * The bank accounts a business keeps, and what is waiting on each.
 *
 * The count beside each account is unmatched statement lines, which is the only
 * number worth putting here: it is the work outstanding, and it is a fact about
 * imported rows rather than an estimate of anything.
 */
export default async function BankingPage() {
  const context = await requirePermission("banking.view");
  const canReconcile = context.permissions.has("banking.reconcile");

  const [accounts, ledgerAccounts] = await Promise.all([
    listBankAccounts(context.company.id),
    canReconcile ? bankableAccounts(context.company.id) : Promise.resolve([]),
  ]);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <MasterDataHeader
        title="Bank reconciliation"
        description="Import a statement and match it against what the books already say. Matching links the two — it never posts an entry, and never changes a figure on either side."
        aside={
          canReconcile && ledgerAccounts.length > 0 ? (
            <AddBankAccountDialog accounts={ledgerAccounts} />
          ) : undefined
        }
      />

      {accounts.length === 0 ? (
        <div className="rounded-lg border border-dashed px-5 py-8 text-center">
          <p className="text-sm font-medium">No bank accounts yet</p>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
            Add one for each real account you hold, pointing at the ledger
            account it belongs to. Statements are imported per account, so two
            current accounts reconcile separately.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {accounts.map((account) => (
            <li key={account.id}>
              <Link
                href={`/app/accounting/banking/${account.id}`}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3.5 transition-colors hover:bg-accent/40"
              >
                <div>
                  <p className="font-medium">{account.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {[
                      account.bankName,
                      account.accountNumber,
                      BANK_ACCOUNT_TYPE_LABELS[
                        account.type as keyof typeof BANK_ACCOUNT_TYPE_LABELS
                      ] ?? account.type,
                      `${account.accountCode} ${account.accountName}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <span
                  className={
                    account.unreconciledCount > 0
                      ? "rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-700 dark:text-amber-400"
                      : "rounded-full border px-2.5 py-1 text-xs text-muted-foreground"
                  }
                >
                  {account.unreconciledCount > 0
                    ? `${account.unreconciledCount} to reconcile`
                    : "Nothing outstanding"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
        A statement is evidence, not an instruction. Importing one records what
        the bank says happened; it does not post anything to your books, and a
        line that turns out to be a sale or a purchase is recorded in the module
        that owns it. The two exceptions are bank charges and bank interest,
        which only ever appear on a statement first.
      </p>
    </div>
  );
}
