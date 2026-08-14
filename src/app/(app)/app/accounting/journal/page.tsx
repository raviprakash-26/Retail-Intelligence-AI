import type { Metadata } from "next";
import { JournalList } from "@/components/accounting/journal-list";
import { MasterDataHeader } from "@/components/master-data/page-header";
import { requirePermission } from "@/server/auth/context";
import { listJournalEntries } from "@/server/accounting/journal-service";

export const metadata: Metadata = {
  title: "Journal",
  robots: { index: false, follow: false },
};

/**
 * Every entry the books contain.
 *
 * Most of them were produced by a document, and that is what the register is
 * for: seeing that a shop's accounting is not something happening elsewhere,
 * but the direct consequence of the sales and bills already recorded.
 */
export default async function JournalPage({
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

  const origin = single("origin");

  const result = await listJournalEntries({
    companyId: context.company.id,
    query: single("q"),
    voucherType: single("type"),
    from: single("from"),
    to: single("to"),
    origin: origin === "manual" || origin === "system" ? origin : undefined,
    page: Number(single("page") ?? 1) || 1,
  });

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <MasterDataHeader
        title="Journal"
        description="Every entry in the books, whatever produced it. A sale, a bill, an expense and a receipt each post one automatically; the few that have no document behind them are posted here by hand."
      />

      <JournalList
        result={result}
        canCreate={context.permissions.has("accounting.journal.create")}
      />
    </div>
  );
}
