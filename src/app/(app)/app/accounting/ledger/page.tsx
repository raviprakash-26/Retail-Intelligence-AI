import type { Metadata } from "next";
import { LedgerView } from "@/components/accounting/ledger-view";
import { MasterDataHeader } from "@/components/master-data/page-header";
import { formatCurrency } from "@/lib/format";
import { requirePermission } from "@/server/auth/context";
import {
  describeBalance,
  getAccountLedger,
  ledgerAccounts,
  ledgerParties,
  LedgerError,
  type AccountLedger,
} from "@/server/accounting/ledger-service";

export const metadata: Metadata = {
  title: "Ledger",
  robots: { index: false, follow: false },
};

/**
 * The ledger.
 *
 * One account at a time, chosen from the chart, with an optional date window
 * and — on a control account — an optional single customer or supplier, which
 * turns it into the statement a retailer sends someone disputing a balance.
 *
 * The statement reconciles with the ageing report by construction: both read
 * the same posted lines rather than separate running totals.
 */
export default async function LedgerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await requirePermission("accounting.view");
  const params = await searchParams;

  const single = (key: string): string | undefined => {
    const value = params[key];
    const found = Array.isArray(value) ? value[0] : value;
    return found || undefined;
  };

  const accountId = single("account");
  const accounts = await ledgerAccounts(context.company.id);

  let ledger: AccountLedger | null = null;
  let error: string | null = null;

  if (accountId) {
    try {
      ledger = await getAccountLedger({
        companyId: context.company.id,
        accountId,
        from: single("from"),
        to: single("to"),
        partyId: single("party"),
        page: Number(single("page") ?? 1) || 1,
      });
    } catch (thrown) {
      if (thrown instanceof LedgerError) error = thrown.message;
      else throw thrown;
    }
  }

  const parties = ledger?.account.partyType
    ? await ledgerParties({
        companyId: context.company.id,
        partyType: ledger.account.partyType,
      })
    : [];

  const closing = ledger
    ? describeBalance({
        type: ledger.account.type,
        nature: ledger.account.nature,
        balance: ledger.closingBalance,
        partyName: ledger.party?.name ?? null,
      })
    : null;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <MasterDataHeader
        title={ledger ? ledger.account.name : "Ledger"}
        description={
          ledger
            ? `${ledger.account.code} · ${ledger.account.groupName}. Every movement in date order, with the balance running beside it.`
            : "Every account in your chart has a ledger — each movement in date order, with the balance running beside it. On a customer or supplier account you can narrow it to one name, which is the statement you would send them."
        }
        aside={
          ledger && closing ? (
            <div className="rounded-lg border px-4 py-2.5 text-right">
              <p className="text-xs text-muted-foreground">{closing}</p>
              <p className="tabular-figures text-lg font-semibold">
                {formatCurrency(Math.abs(Number(ledger.closingBalance)), {
                  compactZeroDecimals: true,
                })}
                {Number(ledger.closingBalance) !== 0 && (
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    {Number(ledger.closingBalance) < 0 ? "Cr" : "Dr"}
                  </span>
                )}
              </p>
            </div>
          ) : undefined
        }
      />

      {error && (
        <p className="mb-5 rounded-lg border border-destructive/40 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}

      <LedgerView ledger={ledger} accounts={accounts} parties={parties} />
    </div>
  );
}
