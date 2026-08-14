import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { getPayrollRun, PayrollError } from "@/server/payroll/payroll-service";

export const metadata: Metadata = {
  title: "Payroll run",
  robots: { index: false, follow: false },
};

/**
 * One run: a payslip per employee, and the entry the whole thing produced.
 *
 * The entry is on the page for the same reason it is on an invoice. A
 * shopkeeper who can see that ₹40,000 of salary became ₹35,200 owed to staff,
 * ₹3,600 owed to the EPFO and ₹200 to the state has been told where the money
 * went, which a single "salaries paid" figure never manages.
 */
export default async function PayrollRunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const context = await requirePermission("payroll.view");
  const { id } = await params;

  const detail = await getPayrollRun({
    companyId: context.company.id,
    id,
  }).catch((error: unknown) => {
    if (error instanceof PayrollError) notFound();
    throw error;
  });

  const { run, entry, label } = detail;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <Link
        href="/app/payroll"
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline print:hidden"
      >
        <ArrowLeft className="size-3.5" />
        All payroll
      </Link>

      <header className="mb-6">
        <h1 className="flex flex-wrap items-center gap-2.5 text-2xl font-semibold tracking-tight">
          {label}
          <Badge variant={run.status === "CANCELLED" ? "danger" : "success"}>
            {run.status === "CANCELLED" ? "Cancelled" : "Posted"}
          </Badge>
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {run.reference} · paid {formatDate(run.payDate, { style: "long" })} ·{" "}
          {run.items.length} {run.items.length === 1 ? "person" : "people"}
        </p>
      </header>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Payslips</CardTitle>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <div className="overflow-x-auto">
              <Table className="border-0">
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">Employee</TableHead>
                    <TableHead className="text-right">Basic</TableHead>
                    <TableHead className="text-right">Allowances</TableHead>
                    <TableHead className="text-right">PF</TableHead>
                    <TableHead className="text-right">ESI</TableHead>
                    <TableHead className="text-right">PT</TableHead>
                    <TableHead className="text-right">TDS</TableHead>
                    <TableHead className="pr-6 text-right">Net</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {run.items.map((item) => (
                    <TableRow key={item.employee.employeeCode}>
                      <TableCell className="pl-6">
                        <p className="font-medium">{item.employee.name}</p>
                        <p className="font-mono text-xs text-muted-foreground">
                          {item.employee.employeeCode}
                        </p>
                      </TableCell>
                      <TableCell className="tabular-figures text-right">
                        {formatCurrency(item.basicSalary)}
                      </TableCell>
                      <TableCell className="tabular-figures text-right">
                        {formatCurrency(item.allowances)}
                      </TableCell>
                      <TableCell className="tabular-figures text-right text-muted-foreground">
                        {formatCurrency(item.employeeProvidentFund)}
                      </TableCell>
                      <TableCell className="tabular-figures text-right text-muted-foreground">
                        {formatCurrency(item.employeeStateInsurance)}
                      </TableCell>
                      <TableCell className="tabular-figures text-right text-muted-foreground">
                        {formatCurrency(item.professionalTax)}
                      </TableCell>
                      <TableCell className="tabular-figures text-right text-muted-foreground">
                        {formatCurrency(item.taxDeductedAtSource)}
                      </TableCell>
                      <TableCell className="tabular-figures pr-6 text-right font-medium">
                        {formatCurrency(item.netSalary)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <p className="border-t px-6 py-3 text-xs leading-relaxed text-muted-foreground">
              Gross {formatCurrency(run.grossAmount)} less{" "}
              {formatCurrency(run.deductionAmount)} withheld leaves{" "}
              {formatCurrency(run.netAmount)} owed to staff. The business also
              contributed {formatCurrency(run.employerContributions)} on top,
              which is a cost rather than a deduction — nobody&rsquo;s pay was
              reduced by it.
            </p>
          </CardContent>
        </Card>

        {entry && (
          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                Journal entry {entry.entryNumber}
                {entry.status === "REVERSED" && (
                  <Badge variant="muted">Reversed</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              <Table className="border-0">
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">Account</TableHead>
                    <TableHead className="text-right">Debit</TableHead>
                    <TableHead className="pr-6 text-right">Credit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entry.lines.map((line) => (
                    <TableRow key={line.lineNumber}>
                      <TableCell className="pl-6">
                        <p className="text-sm">{line.account.name}</p>
                        <p className="font-mono text-xs text-muted-foreground">
                          {line.account.code}
                        </p>
                      </TableCell>
                      <TableCell className="tabular-figures text-right">
                        {Number(line.debit) === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          formatCurrency(line.debit)
                        )}
                      </TableCell>
                      <TableCell className="tabular-figures pr-6 text-right">
                        {Number(line.credit) === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          formatCurrency(line.credit)
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <p className="border-t px-6 py-3 text-xs leading-relaxed text-muted-foreground">
                Debits equal credits at {formatCurrency(entry.totalDebit)}. The
                deductions are credited to one account per authority rather than
                to a single &ldquo;deductions&rdquo; line, because provident
                fund, insurance, professional tax and TDS are paid to four
                different places on four different dates.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
