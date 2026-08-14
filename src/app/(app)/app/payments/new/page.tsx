import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PaymentForm } from "@/components/settlements/payment-form";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/server/auth/context";

export const metadata: Metadata = {
  title: "Record payment",
  robots: { index: false, follow: false },
};

/** Recording money out. Mirrors `/app/receipts/new`. */
export default async function NewPaymentPage() {
  const context = await requirePermission("payments.create");

  const suppliers = await prisma.supplier.findMany({
    where: { companyId: context.company.id, archivedAt: null },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
    take: 500,
  });

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <Link
        href="/app/payments"
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        <ArrowLeft className="size-3.5" />
        All payments
      </Link>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          Record payment
        </h1>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          Money going out. Match it to the bills it settles so what you owe each
          supplier stays accurate without anyone reconciling by hand.
        </p>
      </header>

      <PaymentForm suppliers={suppliers} />
    </div>
  );
}
