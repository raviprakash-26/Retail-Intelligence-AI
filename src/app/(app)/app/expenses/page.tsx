import type { Metadata } from "next";
import {
  ExpenseBreakdown,
  ExpensesList,
} from "@/components/expenses/expenses-list";
import { MasterDataHeader } from "@/components/master-data/page-header";
import { formatCurrency } from "@/lib/format";
import { requirePermission } from "@/server/auth/context";
import {
  listExpenseCategories,
  listExpenses,
} from "@/server/expenses/expense-service";

export const metadata: Metadata = {
  title: "Expenses",
  robots: { index: false, follow: false },
};

export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await requirePermission("expenses.view");
  const params = await searchParams;

  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const [result, categories] = await Promise.all([
    listExpenses({
      companyId: context.company.id,
      query: single("q"),
      categoryId: single("filter"),
      page: Number(single("page") ?? 1) || 1,
    }),
    listExpenseCategories(context.company.id),
  ]);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <MasterDataHeader
        title="Expenses"
        description="What it costs to keep the shop open. Each expense posts to its own account, so the profit and loss account adds up without anyone sorting receipts at the end of the year."
        aside={
          Number(result.postedExpense) > 0 || Number(result.capitalised) > 0 ? (
            <div className="flex gap-6 rounded-lg border px-4 py-2.5">
              <div>
                <p className="text-xs text-muted-foreground">Cost so far</p>
                <p className="tabular-figures text-lg font-semibold">
                  {formatCurrency(result.postedExpense, {
                    compactZeroDecimals: true,
                  })}
                </p>
              </div>
              {Number(result.capitalised) > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground">Capitalised</p>
                  <p className="tabular-figures text-lg font-semibold">
                    {formatCurrency(result.capitalised, {
                      compactZeroDecimals: true,
                    })}
                  </p>
                </div>
              )}
              {Number(result.inputCredit) > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground">Input credit</p>
                  <p className="tabular-figures text-lg font-semibold">
                    {formatCurrency(result.inputCredit, {
                      compactZeroDecimals: true,
                    })}
                  </p>
                </div>
              )}
            </div>
          ) : undefined
        }
      />

      <ExpenseBreakdown result={result} />

      <ExpensesList
        result={result}
        categories={categories}
        canCreate={context.permissions.has("expenses.create")}
      />
    </div>
  );
}
