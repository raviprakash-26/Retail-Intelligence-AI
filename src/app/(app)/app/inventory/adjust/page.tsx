import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AdjustmentForm } from "@/components/inventory/adjustment-form";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/server/auth/context";

export const metadata: Metadata = {
  title: "Correct a count",
  robots: { index: false, follow: false },
};

export default async function AdjustStockPage() {
  const context = await requirePermission("inventory.adjust");

  const products = await prisma.product.findMany({
    where: {
      companyId: context.company.id,
      isStockTracked: true,
      archivedAt: null,
    },
    select: {
      id: true,
      sku: true,
      name: true,
      unit: { select: { code: true } },
    },
    orderBy: { name: "asc" },
    take: 500,
  });

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <Link
        href="/app/inventory"
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        <ArrowLeft className="size-3.5" />
        Inventory
      </Link>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          Correct a count
        </h1>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          A physical count almost never matches the books exactly — things get
          dropped, spoiled, taken or miscounted at the till. Recording the
          difference honestly is what keeps the stock figure worth reading, and
          what stops the loss surfacing later as an unexplained gap in your
          margin.
        </p>
      </header>

      <AdjustmentForm
        products={products.map((product) => ({
          id: product.id,
          sku: product.sku,
          name: product.name,
          unitCode: product.unit.code,
        }))}
      />
    </div>
  );
}
