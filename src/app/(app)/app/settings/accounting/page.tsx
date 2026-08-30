import type { Metadata } from "next";
import { Lock } from "lucide-react";
import { AccountingSettingsForm } from "@/components/settings/accounting-settings-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { prisma } from "@/lib/db";
import { asBusinessTimezone } from "@/lib/validation/company";
import { requirePermission } from "@/server/auth/context";
import { describeAccountingLocks } from "@/server/company/settings-service";

export const metadata: Metadata = {
  title: "Accounting settings",
  robots: { index: false, follow: false },
};

export default async function AccountingSettingsPage() {
  const context = await requirePermission("settings.view");
  const canEdit = context.permissions.has("settings.manage");

  const [company, locks] = await Promise.all([
    prisma.company.findUniqueOrThrow({
      where: { id: context.company.id },
      select: {
        fiscalYearStartMonth: true,
        currency: true,
        inventoryMethod: true,
        timezone: true,
      },
    }),
    describeAccountingLocks(context.company.id),
  ]);

  return (
    <div className="space-y-6">
      {!canEdit && (
        <Alert>
          <Lock />
          <AlertDescription>
            <p>
              You can view these settings but not change them. Ask an Owner or
              your Accountant if something needs updating.
            </p>
          </AlertDescription>
        </Alert>
      )}

      <AccountingSettingsForm
        defaultValues={{
          ...company,
          timezone: asBusinessTimezone(company.timezone),
        }}
        locks={locks.locks}
        readOnly={!canEdit}
      />
    </div>
  );
}
