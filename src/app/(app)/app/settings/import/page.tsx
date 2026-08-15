import type { Metadata } from "next";
import { ImportView } from "@/components/settings/import-view";
import { datasetList } from "@/lib/import/datasets";
import { requirePermission } from "@/server/auth/context";

export const metadata: Metadata = {
  title: "Bring data in",
  robots: { index: false, follow: false },
};

/**
 * The other half of the export beside it.
 *
 * A product that makes leaving easy and arriving hard is an odd one, and
 * typing four hundred products in by hand is where a trial dies.
 */
export default async function ImportSettingsPage() {
  await requirePermission("data.import");

  return <ImportView datasets={datasetList().map((entry) => entry.key)} />;
}
