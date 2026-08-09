import { ArrowDownRight, ArrowUpRight, Sparkles, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Logo } from "@/components/brand/logo";
import { cn } from "@/lib/utils";

/**
 * A static, illustrative rendering of the application shell.
 *
 * The figures are labelled as an illustration and are internally consistent
 * with each other (the journal entry below balances, and its amounts tie to
 * the invoice above it) — a marketing image of an accounting product that
 * shows an unbalanced entry undermines the exact claim it is making.
 */

const KPIS = [
  { label: "Monthly sales", value: "₹8,42,500", change: "+14.2%", up: true },
  { label: "Gross profit", value: "₹2,31,180", change: "+9.6%", up: true },
  { label: "Expenses", value: "₹1,04,320", change: "+22.4%", up: false },
  { label: "Cash & bank", value: "₹3,18,940", change: "-4.1%", up: false },
] as const;

/** Monthly revenue and profit, indexed to the tallest bar. */
const SERIES = [
  { month: "Apr", revenue: 52, profit: 16 },
  { month: "May", revenue: 61, profit: 19 },
  { month: "Jun", revenue: 48, profit: 13 },
  { month: "Jul", revenue: 72, profit: 24 },
  { month: "Aug", revenue: 84, profit: 28 },
  { month: "Sep", revenue: 79, profit: 26 },
  { month: "Oct", revenue: 96, profit: 33 },
] as const;

const JOURNAL_LINES = [
  {
    account: "Accounts Receivable — Sharma Stores",
    debit: "53,100.00",
    credit: null,
  },
  { account: "Sales", debit: null, credit: "45,000.00" },
  { account: "GST Output — CGST 9%", debit: null, credit: "4,050.00" },
  { account: "GST Output — SGST 9%", debit: null, credit: "4,050.00" },
] as const;

export function ProductPreview({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border bg-card shadow-xl",
        className,
      )}
      role="img"
      aria-label="Illustration of the Retail Intelligence AI dashboard showing key performance figures, a revenue and profit chart, and the balanced journal entry generated from a sales invoice."
    >
      {/* Window chrome */}
      <div className="flex items-center gap-3 border-b bg-muted/50 px-4 py-3">
        <div className="flex gap-1.5" aria-hidden="true">
          <span className="size-2.5 rounded-full bg-[oklch(0.72_0.16_25)]" />
          <span className="size-2.5 rounded-full bg-[oklch(0.82_0.14_85)]" />
          <span className="size-2.5 rounded-full bg-[oklch(0.76_0.13_150)]" />
        </div>
        <div className="mx-auto hidden rounded-md border bg-background px-3 py-1 text-[0.6875rem] text-muted-foreground sm:block">
          app.retailintelligence.ai / dashboard
        </div>
      </div>

      <div className="grid gap-0 lg:grid-cols-[13rem_1fr]">
        {/* Sidebar */}
        <div className="hidden flex-col gap-1 border-r bg-sidebar p-4 lg:flex">
          <Logo size="sm" className="mb-4 px-1" />
          {[
            "Dashboard",
            "Sales",
            "Purchases",
            "Expenses",
            "Inventory",
            "Accounting",
            "GST & Tax",
            "AI Accountant",
          ].map((item, index) => (
            <div
              key={item}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-[0.8125rem]",
                index === 0
                  ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                  : "text-muted-foreground",
              )}
            >
              {item}
            </div>
          ))}
        </div>

        {/* Main */}
        <div className="space-y-5 p-4 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold">Ravi Retail Mart</p>
              <p className="text-xs text-muted-foreground">
                FY 2026-27 · October
              </p>
            </div>
            <Badge variant="muted" className="text-[0.6875rem]">
              Illustration — not live data
            </Badge>
          </div>

          {/* KPI tiles */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {KPIS.map((kpi) => (
              <div
                key={kpi.label}
                className="rounded-lg border bg-background p-3"
              >
                <p className="text-[0.6875rem] text-muted-foreground">
                  {kpi.label}
                </p>
                <p className="tabular-figures mt-1 text-base font-semibold tracking-tight">
                  {kpi.value}
                </p>
                <p
                  className={cn(
                    "mt-1 flex items-center gap-0.5 text-[0.6875rem] font-medium",
                    kpi.up ? "text-success" : "text-destructive",
                  )}
                >
                  {kpi.up ? (
                    <ArrowUpRight className="size-3" />
                  ) : (
                    <ArrowDownRight className="size-3" />
                  )}
                  {kpi.change}
                </p>
              </div>
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
            {/* Chart */}
            <div className="rounded-lg border bg-background p-4">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium">Revenue vs profit</p>
                <div className="flex items-center gap-3 text-[0.625rem]">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span className="size-2 rounded-[2px] bg-chart-1" />
                    Revenue
                  </span>
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span className="size-2 rounded-[2px] bg-chart-2" />
                    Profit
                  </span>
                </div>
              </div>

              <div
                className="mt-4 flex h-32 items-end gap-2"
                aria-hidden="true"
              >
                {SERIES.map((point) => (
                  <div
                    key={point.month}
                    className="flex flex-1 flex-col items-center gap-1.5"
                  >
                    <div className="flex h-full w-full items-end justify-center gap-[3px]">
                      <div
                        className="w-1/2 rounded-t-[3px] bg-chart-1"
                        style={{ height: `${point.revenue}%` }}
                      />
                      <div
                        className="w-1/2 rounded-t-[3px] bg-chart-2"
                        style={{ height: `${point.profit}%` }}
                      />
                    </div>
                    <span className="text-[0.5625rem] text-muted-foreground">
                      {point.month}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* AI insight */}
            <div className="rounded-lg border border-ai/20 bg-ai-muted/60 p-4">
              <div className="flex items-center gap-1.5 text-ai">
                <Sparkles className="size-3.5" />
                <p className="text-xs font-semibold">AI Accountant</p>
              </div>
              <p className="mt-2.5 text-xs leading-relaxed text-foreground/85">
                Gross margin improved to{" "}
                <span className="font-semibold">27.4%</span> from 25.1% last
                month. Electricity is up{" "}
                <span className="font-semibold">22%</span> — the largest single
                expense increase.
              </p>
              <p className="mt-2.5 text-[0.625rem] text-muted-foreground">
                Source: Trading Account &amp; Expense Register, Oct 2026
              </p>
            </div>
          </div>

          {/* The generated journal entry */}
          <div className="rounded-lg border bg-background">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
              <p className="text-xs font-medium">
                Auto-generated journal · INV-0142
              </p>
              <Badge variant="success" className="text-[0.625rem]">
                <Wallet className="size-2.5" />
                Balanced
              </Badge>
            </div>
            <table className="w-full text-[0.6875rem]">
              <thead className="text-muted-foreground">
                <tr className="border-b">
                  <th scope="col" className="px-4 py-1.5 text-left font-medium">
                    Account
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-1.5 text-right font-medium"
                  >
                    Debit
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-1.5 text-right font-medium"
                  >
                    Credit
                  </th>
                </tr>
              </thead>
              <tbody>
                {JOURNAL_LINES.map((line) => (
                  <tr key={line.account} className="border-b last:border-b-0">
                    <td className="px-4 py-1.5">{line.account}</td>
                    <td className="tabular-figures px-4 py-1.5 text-right">
                      {line.debit ?? "—"}
                    </td>
                    <td className="tabular-figures px-4 py-1.5 text-right">
                      {line.credit ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-muted/50 font-semibold">
                  <td className="px-4 py-1.5">Total</td>
                  <td className="tabular-figures px-4 py-1.5 text-right">
                    53,100.00
                  </td>
                  <td className="tabular-figures px-4 py-1.5 text-right">
                    53,100.00
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
