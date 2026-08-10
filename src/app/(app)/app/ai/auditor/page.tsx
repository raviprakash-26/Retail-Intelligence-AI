import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/shell/module-placeholder";
import { requirePermission } from "@/server/auth/context";

export const metadata: Metadata = {
  title: "AI Auditor",
  robots: { index: false, follow: false },
};

export default async function AiAuditorPage() {
  await requirePermission("ai.auditor");

  return (
    <ModulePlaceholder
      title="AI Auditor"
      icon="ShieldCheck"
      phase={21}
      description="Continuous checks for the anomalies that usually turn out to be mistakes."
      willInclude={[
        "Duplicate invoices, missing numbers, negative stock and cash",
        "Unusual amounts, discounts and timing",
        "GST inconsistencies and ledger mismatches",
        "A deterministic audit score with severity-ranked findings",
        "Findings describe risk — they never allege fraud",
      ]}
    />
  );
}
