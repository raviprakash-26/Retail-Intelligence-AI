import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { MasterDataHeader } from "@/components/master-data/page-header";
import { ReconciliationView } from "@/components/banking/reconciliation-view";
import { requirePermission } from "@/server/auth/context";
import { getBankAccount } from "@/server/banking/bank-account-service";
import { reconciliationView } from "@/server/banking/reconciliation-service";
import { formatDate } from "@/lib/format";

export const metadata: Metadata = {
  title: "Reconcile",
  robots: { index: false, follow: false },
};

/**
 * Reconciling one bank account over one window.
 *
 * The window defaults to the current month, because that is the unit a bank
 * statement arrives in. It is part of the URL so a reconciliation somebody is
 * halfway through survives a refresh and can be sent to whoever keeps the
 * books.
 */
function monthWindow(from?: string, to?: string): { from: Date; to: Date } {
  const now = new Date();
  const parsed = (value: string | undefined): Date | null => {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  };

  const start =
    parsed(from) ??
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end =
    parsed(to) ??
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));

  // A window that runs backwards would silently report nothing at all, which
  // reads as "you have no transactions" rather than "that window is wrong".
  return start > end ? { from: end, to: start } : { from: start, to: end };
}

export default async function ReconcilePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await requirePermission("banking.view");
  const { id } = await params;
  const search = await searchParams;

  const single = (key: string): string | undefined => {
    const value = search[key];
    const found = Array.isArray(value) ? value[0] : value;
    return found || undefined;
  };

  const account = await getBankAccount({
    companyId: context.company.id,
    bankAccountId: id,
  });
  // A bank account belonging to another company is not found, rather than
  // refused: whether it exists is itself somebody else's business.
  if (!account) notFound();

  const window = monthWindow(single("from"), single("to"));
  const view = await reconciliationView({
    companyId: context.company.id,
    bankAccountId: account.id,
    from: window.from,
    to: window.to,
  });
  if (!view) notFound();

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <Link
        href="/app/accounting/banking"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-2 hover:underline"
      >
        <ArrowLeft className="size-3.5" />
        All bank accounts
      </Link>

      <MasterDataHeader
        title={account.name}
        description={`${[account.bankName, account.accountNumber].filter(Boolean).join(" · ")} — reconciling ${formatDate(view.from)} to ${formatDate(view.to)}. Figures on the right come from posted journal entries; figures on the left come from the statement you imported.`}
      />

      <ReconciliationView
        bankAccountId={account.id}
        statement={view.statement}
        book={view.book}
        unmatchedStatement={view.unmatchedStatement}
        unmatchedBook={view.unmatchedBook}
        suggestions={view.suggestions}
        difference={{
          perBooks: view.difference.perBooks.toString(),
          perStatement: view.difference.perStatement.toString(),
          unpresentedNet: view.difference.unpresentedNet.toString(),
          unrecordedNet: view.difference.unrecordedNet.toString(),
          unexplained: view.difference.unexplained.toString(),
        }}
        neverImported={view.neverImported}
        canReconcile={context.permissions.has("banking.reconcile")}
        canPost={context.permissions.has("accounting.journal.create")}
      />
    </div>
  );
}
