import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ExpenseForm } from "@/components/expenses/expense-form";
import { prisma } from "@/lib/db";
import type { GstRegistration } from "@/lib/tax/gst";
import { requirePermission } from "@/server/auth/context";
import { listExpenseCategories } from "@/server/expenses/expense-service";
import { businessToday } from "@/lib/validation/date";
import {
  postingBranchId,
  postingStateCode,
} from "@/server/company/posting-branch";

export const metadata: Metadata = {
  title: "Record expense",
  robots: { index: false, follow: false },
};

export default async function NewExpensePage() {
  const context = await requirePermission("expenses.create");

  // The state the form previews tax from is the state the service will post
  // from: the branch this member lands on, which may not be the head office.
  const postingState = await postingStateCode(prisma, {
    companyId: context.company.id,
    branchId: await postingBranchId(prisma, {
      companyId: context.company.id,
      memberBranchId: context.membership.branchId,
    }),
    companyStateCode: context.company.stateCode,
  });

  const [categories, suppliers] = await Promise.all([
    listExpenseCategories(context.company.id),
    prisma.supplier.findMany({
      where: { companyId: context.company.id, archivedAt: null },
      select: { id: true, name: true, gstin: true, stateCode: true },
      orderBy: { name: "asc" },
      take: 500,
    }),
  ]);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <Link
        href="/app/expenses"
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        <ArrowLeft className="size-3.5" />
        All expenses
      </Link>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          Record expense
        </h1>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          What was spent, and what it was for. The category decides which
          account it posts to; the rest follows.
        </p>
      </header>

      <ExpenseForm
        categories={categories}
        today={businessToday(context.company.timezone)}
        suppliers={suppliers}
        company={{
          stateCode: postingState,
          gstRegistration: context.company.gstRegistration as GstRegistration,
        }}
      />
    </div>
  );
}
