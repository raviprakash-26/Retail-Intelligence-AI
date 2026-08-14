"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { FormError } from "@/components/auth/form-error";
import { AmountInput } from "@/components/ui/amount-input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCurrency } from "@/lib/format";
import type { PayrollPreview } from "@/server/payroll/payroll-service";
import { runPayrollAction } from "@/server/payroll/actions";

/**
 * Reviewing a run before posting it.
 *
 * Payroll is the one document people want to see in full before they commit,
 * so the preview is the page and posting is a button on it. Salaries are not
 * editable here — they come from the employee records, and a payslip that
 * silently disagreed with the contract would be the wrong place to fix a
 * salary.
 *
 * The one figure this form does collect is TDS, per employee, because the
 * platform does not compute it and will not pretend to.
 */
export function RunPayrollForm({
  preview,
  payDate,
}: {
  preview: PayrollPreview;
  payDate: string;
}) {
  const router = useRouter();
  const [tax, setTax] = React.useState<Record<string, number>>({});
  const [date, setDate] = React.useState(payDate);
  const [error, setError] = React.useState<string | null>(null);
  const [posting, setPosting] = React.useState(false);

  const grossTotal = Number(preview.totals.gross);
  const withheld = preview.payslips.reduce(
    (sum, slip) =>
      sum +
      Number(slip.employeeProvidentFund) +
      Number(slip.employeeStateInsurance) +
      Number(slip.professionalTax) +
      (tax[slip.employeeId] ?? 0),
    0,
  );
  const netTotal = grossTotal - withheld;

  async function post() {
    setPosting(true);
    setError(null);
    const result = await runPayrollAction({
      year: preview.periodYear,
      month: preview.periodMonth,
      payDate: date,
      taxDeducted: tax,
    });
    setPosting(false);

    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.push(`/app/payroll/${result.data.id}` as Route);
    router.refresh();
  }

  if (preview.payslips.length === 0) {
    return (
      <Alert>
        <AlertTitle>Nobody to pay</AlertTitle>
        <AlertDescription>
          There are no active employees. Add staff before running payroll.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-5">
      {preview.alreadyRun && (
        <Alert variant="destructive">
          <AlertTitle>{preview.label} has already been run</AlertTitle>
          <AlertDescription>
            A period can only be paid once. Open the existing run to see what
            was posted.
          </AlertDescription>
        </Alert>
      )}

      <FormError message={error} />

      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="payDate" className="text-xs text-muted-foreground">
            Pay date
          </Label>
          <Input
            id="payDate"
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            className="w-44"
          />
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Employee</th>
              <th className="px-3 py-2 text-right font-medium">Gross</th>
              <th className="px-3 py-2 text-right font-medium">PF</th>
              <th className="px-3 py-2 text-right font-medium">ESI</th>
              <th className="px-3 py-2 text-right font-medium">PT</th>
              <th className="w-32 px-3 py-2 text-right font-medium">TDS</th>
              <th className="px-3 py-2 text-right font-medium">Net</th>
            </tr>
          </thead>
          <tbody>
            {preview.payslips.map((slip) => {
              const entered = tax[slip.employeeId] ?? 0;
              const net =
                Number(slip.gross) -
                Number(slip.employeeProvidentFund) -
                Number(slip.employeeStateInsurance) -
                Number(slip.professionalTax) -
                entered;
              return (
                <tr key={slip.employeeId} className="border-b last:border-0">
                  <td className="px-3 py-2">
                    <p className="font-medium">{slip.name}</p>
                    <p className="font-mono text-xs text-muted-foreground">
                      {slip.employeeCode}
                      {slip.designation ? ` · ${slip.designation}` : ""}
                    </p>
                  </td>
                  <td className="tabular-figures px-3 py-2 text-right">
                    {formatCurrency(slip.gross)}
                  </td>
                  <td className="tabular-figures px-3 py-2 text-right text-muted-foreground">
                    {formatCurrency(slip.employeeProvidentFund)}
                  </td>
                  <td className="tabular-figures px-3 py-2 text-right text-muted-foreground">
                    {formatCurrency(slip.employeeStateInsurance)}
                  </td>
                  <td className="tabular-figures px-3 py-2 text-right text-muted-foreground">
                    {formatCurrency(slip.professionalTax)}
                  </td>
                  <td className="px-3 py-2">
                    <AmountInput
                      value={entered}
                      onChange={(value) =>
                        setTax((current) => ({
                          ...current,
                          [slip.employeeId]: value,
                        }))
                      }
                      className="text-right"
                      aria-label={`Tax withheld from ${slip.name}`}
                    />
                  </td>
                  <td className="tabular-figures px-3 py-2 text-right font-medium">
                    {formatCurrency(net)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Figure label="Gross pay" value={grossTotal} />
        <Figure label="Withheld" value={withheld} />
        <Figure label="Net to pay" value={netTotal} strong />
      </div>

      <ul className="space-y-1.5 rounded-lg border bg-muted/30 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
        {preview.notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>

      <Button
        onClick={post}
        disabled={preview.alreadyRun}
        loading={posting}
        loadingText="Posting…"
      >
        Post payroll for {preview.label}
      </Button>
    </div>
  );
}

function Figure({
  label,
  value,
  strong,
}: {
  label: string;
  value: number;
  strong?: boolean;
}) {
  return (
    <div className="rounded-lg border px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={
          strong
            ? "tabular-figures text-lg font-semibold"
            : "tabular-figures text-lg"
        }
      >
        {formatCurrency(value)}
      </p>
    </div>
  );
}
