import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { BillForm } from "@/components/purchases/bill-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { prisma } from "@/lib/db";
import { findStateByCode } from "@/lib/constants/india";
import type { GstRegistration } from "@/lib/tax/gst";
import { requirePermission } from "@/server/auth/context";

export const metadata: Metadata = {
  title: "New bill",
  robots: { index: false, follow: false },
};

export default async function NewPurchasePage() {
  const context = await requirePermission("purchases.create");

  const [suppliers, productCount] = await Promise.all([
    prisma.supplier.findMany({
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

  const blocked = suppliers.length === 0 || productCount === 0;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <Link
        href="/app/purchases"
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        <ArrowLeft className="size-3.5" />
        All bills
      </Link>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">New bill</h1>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          Record what a supplier billed you. The stock, the input tax credit and
          what you owe them all follow from it.
        </p>
      </header>

      {blocked ? (
        <Alert>
          <AlertTitle>
            {suppliers.length === 0
              ? "Add a supplier first"
              : "Add a product first"}
          </AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              {suppliers.length === 0
                ? "A bill has to come from someone. Adding the supplier also records their GSTIN, which is what decides whether their bill carries CGST + SGST or IGST."
                : "A bill line has to name something you buy. Add at least one product — its GST rate and HSN code come with it."}
            </p>
            <Button asChild variant="outline" size="sm">
              <Link
                href={
                  suppliers.length === 0 ? "/app/suppliers" : "/app/products"
                }
              >
                {suppliers.length === 0 ? "Go to suppliers" : "Go to products"}
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <BillForm
          suppliers={suppliers}
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
