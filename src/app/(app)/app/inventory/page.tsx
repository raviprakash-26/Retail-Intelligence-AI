import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/shell/module-placeholder";
import { requirePermission } from "@/server/auth/context";

export const metadata: Metadata = {
  title: "Inventory",
  robots: { index: false, follow: false },
};

export default async function InventoryPage() {
  await requirePermission("inventory.view");

  return (
    <ModulePlaceholder
      title="Inventory"
      icon="Package"
      phase={15}
      description="Stock moves when you sell and buy — not on a separate screen you have to remember."
      willInclude={[
        "Live stock position per product and branch",
        "Movement history you can reconstruct any position from",
        "Weighted average or FIFO valuation",
        "Low stock alerts",
        "Stock adjustments with reasons",
      ]}
    />
  );
}
