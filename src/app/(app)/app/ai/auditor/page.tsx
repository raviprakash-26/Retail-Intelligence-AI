import type { Metadata } from "next";
import { AuditorView } from "@/components/auditor/auditor-view";
import { MasterDataHeader } from "@/components/master-data/page-header";
import { requirePermission } from "@/server/auth/context";
import { getLatestAudit } from "@/server/auditor/audit-service";

export const metadata: Metadata = {
  title: "AI Auditor",
  robots: { index: false, follow: false },
};

/**
 * The auditor.
 *
 * A fixed set of checks over posted entries. Each describes something the books
 * show and carries the ordinary reasons it happens; none of them concludes that
 * anybody has done anything wrong, because a database query is not in a
 * position to know that. No model produces any of it.
 */
export default async function AuditorPage() {
  const context = await requirePermission("ai.auditor");
  const report = await getLatestAudit({ companyId: context.company.id });

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <MasterDataHeader
        title="AI Auditor"
        description="Checks that a set of books can answer on its own — where the ledger disagrees with itself, where cash or stock goes below nothing, and where a figure is worth a second look. Every finding says what it found and why it usually happens."
      />
      <AuditorView report={report} />
    </div>
  );
}
