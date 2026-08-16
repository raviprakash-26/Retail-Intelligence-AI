import type { Metadata } from "next";
import { MasterDataHeader } from "@/components/master-data/page-header";
import { AgeingPanel } from "@/components/settlements/ageing-panel";
import { SettlementsList } from "@/components/settlements/settlements-list";
import { formatCurrency } from "@/lib/format";
import { RECEIPT_SOURCE_LABELS } from "@/lib/validation/settlements";
import { requirePermission } from "@/server/auth/context";
import { receivablesAgeing } from "@/server/settlements/outstanding";
import { listReceipts } from "@/server/settlements/settlement-service";

export const metadata: Metadata = {
  title: "Receipts",
  robots: { index: false, follow: false },
};

export default async function ReceiptsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await requirePermission("receipts.view");
  const params = await searchParams;

  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const [result, ageing] = await Promise.all([
    listReceipts({
      companyId: context.company.id,
      query: single("q"),
      page: Number(single("page") ?? 1) || 1,
    }),
    receivablesAgeing(context.company.id),
  ]);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <MasterDataHeader
        title="Receipts"
        description="Money coming in. A customer payment is matched to the invoices it settles, so what each customer still owes — and for how long — stays answerable."
        aside={
          Number(result.postedTotal) > 0 ? (
            <div className="rounded-lg border px-4 py-2.5 text-right">
              <p className="text-xs text-muted-foreground">Received</p>
              <p className="tabular-figures text-lg font-semibold">
                {formatCurrency(result.postedTotal, {
                  compactZeroDecimals: true,
                })}
              </p>
            </div>
          ) : undefined
        }
      />

      <AgeingPanel
        remindable
        ageing={ageing}
        title="Owed to you"
        partyNoun="customer"
        emptyNote="Nothing is outstanding. Every credit invoice has been settled."
      />

      <SettlementsList
        result={result}
        kindLabels={Object.fromEntries(
          Object.entries(RECEIPT_SOURCE_LABELS).map(([key, value]) => [
            key,
            value.label,
          ]),
        )}
        copy={{
          basePath: "/app/receipts",
          newLabel: "Record receipt",
          emptyTitle: "No receipts yet",
          emptyBody:
            "Record money as it comes in. Matching it to invoices is what keeps the outstanding position — and the ageing above it — worth reading.",
          noun: "receipt",
          partyHeading: "Customer",
        }}
        canCreate={context.permissions.has("receipts.create")}
      />
    </div>
  );
}
