import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/shell/module-placeholder";
import { requirePermission } from "@/server/auth/context";

export const metadata: Metadata = {
  title: "GST & Tax",
  robots: { index: false, follow: false },
};

export default async function GstPage() {
  await requirePermission("gst.view");

  return (
    <ModulePlaceholder
      title="GST & Tax"
      icon="Landmark"
      phase={16}
      description="Sales and purchase registers, input and output tax, and returns prepared for your review."
      willInclude={[
        "GST sales and purchase registers",
        "Input tax credit and output tax summary",
        "GSTR-1 and GSTR-3B working papers, marked “prepared for review”",
        "GST reconciliation",
        "Tax preparation workspace with estimated figures clearly labelled",
      ]}
    />
  );
}
