import type { Metadata } from "next";
import { MailWarning } from "lucide-react";
import { InviteMemberDialog } from "@/components/settings/invite-member-dialog";
import { PendingInvitations } from "@/components/settings/pending-invitations";
import { TeamTable } from "@/components/settings/team-table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/server/auth/context";
import {
  listAssignableRoles,
  listPendingInvitations,
  listTeamMembers,
} from "@/server/company/team-service";

export const metadata: Metadata = {
  title: "Team",
  robots: { index: false, follow: false },
};

export default async function TeamSettingsPage() {
  const context = await requirePermission("users.view");
  const canManage = context.permissions.has("users.manage");
  const emailVerified = Boolean(context.user.emailVerifiedAt);

  const [members, invitations, roles, branches] = await Promise.all([
    listTeamMembers(context.company.id),
    canManage
      ? listPendingInvitations(context.company.id)
      : Promise.resolve([]),
    listAssignableRoles(context.company.id),
    prisma.branch.findMany({
      where: { companyId: context.company.id, isActive: true },
      select: { id: true, name: true },
      orderBy: { code: "asc" },
    }),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Team</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Everyone who can sign in to {context.company.name}, and what each of
            them can do.
          </p>
        </div>

        {canManage && (
          <InviteMemberDialog
            roles={roles}
            branches={branches}
            canInvite={emailVerified}
            blockedReason={
              emailVerified
                ? null
                : "Confirm your own email address before inviting others."
            }
          />
        )}
      </div>

      {canManage && !emailVerified && (
        <Alert variant="warning">
          <MailWarning />
          <AlertTitle>Confirm your email before inviting your team</AlertTitle>
          <AlertDescription>
            <p>
              Granting access to your books is not something an unconfirmed
              address should be able to do. Use the banner on your dashboard to
              send yourself a fresh confirmation link.
            </p>
          </AlertDescription>
        </Alert>
      )}

      <TeamTable
        members={members.map((member) => ({
          membershipId: member.membershipId,
          userId: member.userId,
          fullName: member.fullName,
          email: member.email,
          status: member.status,
          roleId: member.roleId,
          roleName: member.roleName,
          branchName: member.branchName,
          emailVerified: member.emailVerified,
          lastLoginAt: member.lastLoginAt?.toISOString() ?? null,
          isOwner: member.isOwner,
        }))}
        roles={roles}
        currentUserId={context.user.id}
        canManage={canManage}
      />

      <PendingInvitations
        invitations={invitations.map((invitation) => ({
          id: invitation.id,
          email: invitation.email,
          fullName: invitation.fullName,
          roleName: invitation.roleName,
          expiresAt: invitation.expiresAt.toISOString(),
          expired: invitation.expired,
        }))}
        canManage={canManage}
      />
    </div>
  );
}
