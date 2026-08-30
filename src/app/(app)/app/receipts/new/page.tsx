import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ReceiptForm } from "@/components/settlements/receipt-form";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/server/auth/context";
import { businessToday } from "@/lib/validation/date";

export const metadata: Metadata = {
  title: "Record receipt",
  robots: { index: false, follow: false },
};

/**
 * Recording money in.
 *
 * The customer list is fetched here rather than in the browser: it is the same
 * on every render, and the outstanding position of every customer is not
 * something a form should be handed before anyone has chosen one.
 */
export default async function NewReceiptPage() {
  const context = await requirePermission("receipts.create");

  const customers = await prisma.customer.findMany({
    where: { companyId: context.company.id, archivedAt: null },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
    take: 500,
  });

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <Link
        href="/app/receipts"
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        <ArrowLeft className="size-3.5" />
        All receipts
      </Link>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          Record receipt
        </h1>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          Money coming in. Match it to the invoices it settles and the ageing
          report answers itself; leave it unmatched and it still reduces what
          the customer owes, it just sits on account.
        </p>
      </header>

      <ReceiptForm
        customers={customers}
        today={businessToday(context.company.timezone)}
      />
    </div>
  );
}
