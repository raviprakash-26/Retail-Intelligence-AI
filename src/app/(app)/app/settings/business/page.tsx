import type { Metadata } from "next";
import { Lock } from "lucide-react";
import { BusinessProfileForm } from "@/components/settings/business-profile-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { prisma } from "@/lib/db";
import type { CompanyProfileInput } from "@/lib/validation/company";
import { requirePermission } from "@/server/auth/context";

export const metadata: Metadata = {
  title: "Business settings",
  robots: { index: false, follow: false },
};

export default async function BusinessSettingsPage() {
  const context = await requirePermission("settings.view");
  const canEdit = context.permissions.has("settings.manage");

  const company = await prisma.company.findUniqueOrThrow({
    where: { id: context.company.id },
    select: {
      name: true,
      legalName: true,
      businessType: true,
      gstRegistration: true,
      gstin: true,
      pan: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      stateCode: true,
      pincode: true,
      phone: true,
      email: true,
      website: true,
    },
  });

  const defaultValues: CompanyProfileInput = {
    name: company.name,
    legalName: company.legalName ?? "",
    businessType: company.businessType,
    gstRegistration: company.gstRegistration,
    gstin: company.gstin ?? "",
    pan: company.pan ?? "",
    addressLine1: company.addressLine1 ?? "",
    addressLine2: company.addressLine2 ?? "",
    city: company.city ?? "",
    stateCode: company.stateCode ?? "",
    pincode: company.pincode ?? "",
    phone: company.phone ?? "",
    email: company.email ?? "",
    website: company.website ?? "",
  };

  return (
    <div className="space-y-6">
      {!canEdit && (
        <Alert>
          <Lock />
          <AlertDescription>
            <p>
              You can view these details but not change them. Ask an Owner if
              something needs updating.
            </p>
          </AlertDescription>
        </Alert>
      )}

      <BusinessProfileForm defaultValues={defaultValues} readOnly={!canEdit} />
    </div>
  );
}
