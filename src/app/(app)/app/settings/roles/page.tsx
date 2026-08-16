import type { Metadata } from "next";
import { Sparkles } from "lucide-react";
import { RoleManager } from "@/components/settings/role-manager";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { FEATURE } from "@/lib/billing/plans";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { requirePermission } from "@/server/auth/context";
import { featureGate } from "@/server/billing/guards";
import { grantableBy, listRoles } from "@/server/rbac/role-service";

export const metadata: Metadata = {
  title: "Roles",
  robots: { index: false, follow: false },
};

/**
 * Roles a business defines for itself.
 *
 * The pricing page has sold "Custom roles & permissions" as a Business-plan
 * feature since the beginning, and until now no such thing existed — no page,
 * no action, no service. This is the feature that sentence was charging for.
 */
export default async function RolesPage() {
  const context = await requirePermission("roles.manage");
  const [roles, gate] = await Promise.all([
    listRoles(context.company.id),
    featureGate(context.company.id, FEATURE.ADVANCED_PERMISSIONS),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Roles</h1>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          A role is a named bundle of permissions. Nothing in this application
          asks whether somebody is an accountant — it asks whether they may post
          a journal entry — so a business can invent the roles it actually has
          rather than the six it was given.
        </p>
      </div>

      {!gate.included && (
        <Alert variant="info">
          <Sparkles />
          <AlertTitle>Custom roles need a higher plan</AlertTitle>
          <AlertDescription>
            <p>
              Your {gate.entitlements.planName} plan includes the six built-in
              roles below, which you can assign freely. Building your own is
              included from {gate.availableOn ?? "a higher plan"} onwards.
            </p>
          </AlertDescription>
        </Alert>
      )}

      <RoleManager
        roles={roles}
        grantable={grantableBy(context.permissions)}
        descriptions={PERMISSIONS}
        canManage={gate.included}
      />
    </div>
  );
}
