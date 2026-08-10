import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/shell/module-placeholder";
import { requirePermission } from "@/server/auth/context";

export const metadata: Metadata = {
  title: "Employees",
  robots: { index: false, follow: false },
};

export default async function EmployeesPage() {
  await requirePermission("employees.view");

  return (
    <ModulePlaceholder
      title="Employees"
      icon="IdCard"
      phase={5}
      description="Your team, their salaries, and payroll that posts through the accounting engine."
      willInclude={[
        "Employee records with designation and department",
        "Basic salary, allowances and deductions",
        "Monthly payroll runs",
        "Salary payments posted to the ledger",
      ]}
    />
  );
}
