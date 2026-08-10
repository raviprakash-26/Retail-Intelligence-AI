import type { Metadata } from "next";
import { MasterDataHeader } from "@/components/master-data/page-header";
import { AgeingPanel } from "@/components/settlements/ageing-panel";
import { SettlementsList } from "@/components/settlements/settlements-list";
import { formatCurrency } from "@/lib/format";
import { PAYMENT_PURPOSE_LABELS } from "@/lib/validation/settlements";
import { requirePermission } from "@/server/auth/context";
import { payablesAgeing } from "@/server/settlements/outstanding";
import { listPayments } from "@/server/settlements/settlement-service";

export const metadata: Metadata = {
  title: "Payments",
  robots: { index: false, follow: false },
};

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await requirePermission("payments.view");
  const params = await searchParams;

  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const [result, ageing] = await Promise.all([
    listPayments({
      companyId: context.company.id,
      query: single("q"),
      page: Number(single("page") ?? 1) || 1,
    }),
    payablesAgeing(context.company.id),
  ]);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <MasterDataHeader
        title="Payments"
        description="Money going out. A supplier payment is matched to the bills it settles, so what you still owe each of them stays accurate without anyone reconciling by hand."
        aside={
          Number(result.postedTotal) > 0 ? (
            <div className="rounded-lg border px-4 py-2.5 text-right">
              <p className="text-xs text-muted-foreground">Paid</p>
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
        ageing={ageing}
        title="You owe"
        partyNoun="supplier"
        emptyNote="Nothing is outstanding. Every bill on credit has been settled."
      />

      <SettlementsList
        result={result}
        kindLabels={Object.fromEntries(
          Object.entries(PAYMENT_PURPOSE_LABELS).map(([key, value]) => [
            key,
            value.label,
          ]),
        )}
        copy={{
          basePath: "/app/payments",
          newLabel: "Record payment",
          emptyTitle: "No payments yet",
          emptyBody:
            "Record money as it goes out. Matching it to bills keeps what you owe each supplier accurate, and the ageing above it honest.",
          noun: "payment",
          partyHeading: "Supplier",
        }}
        canCreate={context.permissions.has("payments.create")}
      />
    </div>
  );
}
