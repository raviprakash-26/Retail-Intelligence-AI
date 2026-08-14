import type { Metadata } from "next";
import Link from "next/link";
import type { Route } from "next";
import { Plus } from "lucide-react";
import { MasterDataHeader } from "@/components/master-data/page-header";
import { PayrollPolicyForm } from "@/components/payroll/payroll-policy-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatDate } from "@/lib/format";
import { requirePermission } from "@/server/auth/context";
import {
  listPayrollRuns,
  payrollPolicy,
} from "@/server/payroll/payroll-service";

export const metadata: Metadata = {
  title: "Payroll",
  robots: { index: false, follow: false },
};

/**
 * Payroll runs, and the policy every one of them is computed under.
 *
 * The policy is on this page rather than buried in settings because it is not
 * a preference — it decides what comes out of somebody's pay, and the person
 * about to run payroll is the person who should see it.
 */
export default async function PayrollPage() {
  const context = await requirePermission("payroll.view");
  const canManage = context.permissions.has("payroll.manage");

  const [runs, policy] = await Promise.all([
    listPayrollRuns(context.company.id),
    payrollPolicy(context.company.id),
  ]);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <MasterDataHeader
        title="Payroll"
        description="Salaries for a month, posted as one balanced entry. Gross pay is a cost, net pay is owed to your staff, and what sits between them is owed to four different authorities — so it is recorded as four separate debts, not one."
        aside={
          canManage ? (
            <Button asChild>
              <Link href="/app/payroll/new">
                <Plus className="size-4" />
                Run payroll
              </Link>
            </Button>
          ) : undefined
        }
      />

      <div className="space-y-6">
        {runs.length === 0 ? (
          <div className="rounded-xl border border-dashed px-6 py-14 text-center">
            <h2 className="text-base font-semibold">No payroll yet</h2>
            <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">
              A run reads the salaries on your employee records, works out the
              statutory deductions and posts the entry. Check the scheme
              settings below first — they decide what is withheld.
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Period</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Paid</TableHead>
                <TableHead className="text-right">Staff</TableHead>
                <TableHead className="text-right">Gross</TableHead>
                <TableHead className="text-right">Withheld</TableHead>
                <TableHead className="text-right">Net</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow key={run.id}>
                  <TableCell>
                    <Link
                      href={`/app/payroll/${run.id}` as Route}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {run.label}
                    </Link>
                    {run.status === "CANCELLED" && (
                      <Badge variant="danger" className="ml-2">
                        Cancelled
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {run.reference}
                  </TableCell>
                  <TableCell className="text-sm">
                    {formatDate(run.payDate, { style: "short" })}
                  </TableCell>
                  <TableCell className="tabular-figures text-right">
                    {run.employees}
                  </TableCell>
                  <TableCell className="tabular-figures text-right">
                    {formatCurrency(run.grossAmount, {
                      compactZeroDecimals: true,
                    })}
                  </TableCell>
                  <TableCell className="tabular-figures text-right text-muted-foreground">
                    {formatCurrency(run.deductionAmount, {
                      compactZeroDecimals: true,
                    })}
                  </TableCell>
                  <TableCell className="tabular-figures text-right font-medium">
                    {formatCurrency(run.netAmount, {
                      compactZeroDecimals: true,
                    })}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        <PayrollPolicyForm defaultValues={policy} readOnly={!canManage} />
      </div>
    </div>
  );
}
