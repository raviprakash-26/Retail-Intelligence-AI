import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { InvoiceForm } from "@/components/sales/invoice-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { prisma } from "@/lib/db";
import { findStateByCode } from "@/lib/constants/india";
import type { GstRegistration } from "@/lib/tax/gst";
import { requirePermission } from "@/server/auth/context";

export const metadata: Metadata = {
  title: "New invoice",
  robots: { index: false, follow: false },
};

export default async function NewSalePage() {
  const context = await requirePermission("sales.create");

  const [customers, sellableCount] = await Promise.all([
    prisma.customer.findMany({
      where: { companyId: context.company.id, archivedAt: null },
      select: {
        id: true,
        name: true,
        gstin: true,
        stateCode: true,
        creditDays: true,
      },
      orderBy: { name: "asc" },
      take: 500,
    }),
    prisma.product.count({
      where: { companyId: context.company.id, archivedAt: null },
    }),
  ]);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <Link
        href="/app/sales"
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        <ArrowLeft className="size-3.5" />
        All invoices
      </Link>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">New invoice</h1>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          Record what was sold. The accounting, the stock movement and the GST
          all follow from it — you enter it once.
        </p>
      </header>

      {sellableCount === 0 ? (
        // Sending someone into an invoice form with nothing to sell wastes
        // their time; the reason and the fix belong together.
        <Alert>
          <AlertTitle>Add a product first</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              An invoice line has to name something you sell. Add at least one
              product — its GST rate and HSN code come with it, so invoices work
              out their own tax.
            </p>
            <Button asChild variant="outline" size="sm">
              <Link href="/app/products">Go to products</Link>
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <InvoiceForm
          customers={customers}
          company={{
            stateCode: context.company.stateCode,
            stateName: context.company.stateCode
              ? (findStateByCode(context.company.stateCode)?.name ?? null)
              : null,
            gstRegistration: context.company.gstRegistration as GstRegistration,
          }}
        />
      )}
    </div>
  );
}
