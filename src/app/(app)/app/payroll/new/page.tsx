import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { RunPayrollForm } from "@/components/payroll/run-payroll-form";
import { requirePermission } from "@/server/auth/context";
import { previewPayroll } from "@/server/payroll/payroll-service";

export const metadata: Metadata = {
  title: "Run payroll",
  robots: { index: false, follow: false },
};

/**
 * The month being paid, previewed in full before anything is posted.
 *
 * Defaults to last month, which is the one a business is usually paying: on
 * the fifth of August, payroll means July.
 */
export default async function RunPayrollPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await requirePermission("payroll.manage");
  const query = await searchParams;
  const single = (name: string): string | undefined => {
    const value = query[name];
    return Array.isArray(value) ? value[0] : value;
  };

  const today = new Date();
  const previousMonth = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1),
  );
  const year = Number(single("year") ?? previousMonth.getUTCFullYear());
  const month = Number(single("month") ?? previousMonth.getUTCMonth() + 1);

  const preview = await previewPayroll({
    companyId: context.company.id,
    year,
    month,
  });

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <Link
        href="/app/payroll"
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        <ArrowLeft className="size-3.5" />
        All payroll
      </Link>

      <h1 className="text-2xl font-semibold tracking-tight">
        Payroll for {preview.label}
      </h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        Salaries come from your employee records. Nothing is posted until you
        say so.
      </p>

      <RunPayrollForm
        preview={preview}
        payDate={today.toISOString().slice(0, 10)}
      />
    </div>
  );
}
