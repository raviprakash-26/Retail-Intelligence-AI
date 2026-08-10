import type { Metadata } from "next";
import { EmployeeManager } from "@/components/master-data/employee-manager";
import { MasterDataHeader } from "@/components/master-data/page-header";
import { formatCurrency } from "@/lib/format";
import { requirePermission } from "@/server/auth/context";
import { listEmployees } from "@/server/master-data/employee-service";

export const metadata: Metadata = {
  title: "Employees",
  robots: { index: false, follow: false },
};

export default async function EmployeesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await requirePermission("employees.view");
  const params = await searchParams;

  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const result = await listEmployees({
    companyId: context.company.id,
    query: single("q"),
    includeFormer: single("archived") === "1",
    page: Number(single("page") ?? 1) || 1,
  });

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <MasterDataHeader
        title="Employees"
        description="The people you employ and the terms they are on. Salary becomes an expense when a payroll run is posted, not when someone is added here."
        aside={
          Number(result.activeMonthlyCost) > 0 ? (
            <div className="rounded-lg border px-4 py-2.5 text-right">
              <p className="text-xs text-muted-foreground">
                Monthly payroll commitment
              </p>
              <p className="text-lg font-semibold tabular-figures">
                {formatCurrency(result.activeMonthlyCost, {
                  compactZeroDecimals: true,
                })}
              </p>
            </div>
          ) : undefined
        }
      />

      <EmployeeManager
        result={result}
        canManage={context.permissions.has("employees.manage")}
      />
    </div>
  );
}
