"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  BadgeCheck,
  EllipsisVertical,
  MailWarning,
  ShieldOff,
  UserCheck,
  UserMinus,
  UserPen,
} from "lucide-react";
import { FormError } from "@/components/auth/form-error";
import type { RoleOption } from "@/components/settings/invite-member-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatRelativeTime, initialsOf } from "@/lib/format";
import {
  changeMemberRoleAction,
  setMemberStatusAction,
} from "@/server/company/actions";

export type TeamRow = {
  membershipId: string;
  userId: string;
  fullName: string;
  email: string;
  status: "INVITED" | "ACTIVE" | "SUSPENDED" | "REVOKED";
  roleId: string;
  roleName: string;
  branchName: string | null;
  emailVerified: boolean;
  lastLoginAt: string | null;
  isOwner: boolean;
};

export function TeamTable({
  members,
  roles,
  currentUserId,
  canManage,
}: {
  members: TeamRow[];
  roles: RoleOption[];
  currentUserId: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<TeamRow | null>(null);

  const activeOwners = members.filter(
    (member) => member.isOwner && member.status === "ACTIVE",
  ).length;

  async function run(
    id: string,
    operation: () => Promise<{ ok: boolean; message?: string }>,
  ) {
    setError(null);
    setPending(id);
    try {
      const result = await operation();
      if (!result.ok) {
        setError(result.message ?? "That change could not be applied.");
        return false;
      }
      router.refresh();
      return true;
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-4">
      <FormError message={error} />

      <div className="overflow-hidden rounded-xl border">
        <table className="w-full text-sm">
          <caption className="sr-only">Team members and their roles</caption>
          <thead className="bg-muted/50 text-muted-foreground">
            <tr className="border-b">
              <th scope="col" className="px-4 py-2.5 text-left font-medium">
                Member
              </th>
              <th scope="col" className="px-4 py-2.5 text-left font-medium">
                Role
              </th>
              <th
                scope="col"
                className="hidden px-4 py-2.5 text-left font-medium sm:table-cell"
              >
                Last active
              </th>
              <th scope="col" className="px-4 py-2.5 text-right font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => {
              const isSelf = member.userId === currentUserId;
              const isLastOwner = member.isOwner && activeOwners <= 1;
              const busy = pending === member.membershipId;

              return (
                <tr
                  key={member.membershipId}
                  className="border-b last:border-b-0"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground">
                        {initialsOf(member.fullName)}
                      </span>
                      <div className="min-w-0">
                        <p className="flex items-center gap-1.5 font-medium">
                          {member.fullName}
                          {isSelf && (
                            <span className="text-xs font-normal text-muted-foreground">
                              (you)
                            </span>
                          )}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {member.email}
                        </p>
                      </div>
                    </div>
                  </td>

                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant={member.isOwner ? "default" : "muted"}>
                        {member.roleName}
                      </Badge>
                      {member.branchName && (
                        <Badge variant="outline" className="font-normal">
                          {member.branchName}
                        </Badge>
                      )}
                      {member.status === "SUSPENDED" && (
                        <Badge variant="warning">Suspended</Badge>
                      )}
                      {!member.emailVerified && (
                        <Badge variant="muted" title="Email not confirmed">
                          <MailWarning className="size-3" />
                          Unconfirmed
                        </Badge>
                      )}
                      {member.emailVerified && member.status === "ACTIVE" && (
                        <BadgeCheck
                          className="size-3.5 text-success"
                          aria-label="Email confirmed"
                        />
                      )}
                    </div>
                  </td>

                  <td className="hidden px-4 py-3 text-muted-foreground sm:table-cell">
                    {member.lastLoginAt
                      ? formatRelativeTime(member.lastLoginAt)
                      : "Never signed in"}
                  </td>

                  <td className="px-4 py-3 text-right">
                    {canManage && !isSelf && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Manage ${member.fullName}`}
                            loading={busy}
                          >
                            <EllipsisVertical className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => setEditing(member)}
                            disabled={isLastOwner}
                          >
                            <UserPen className="size-4" />
                            Change role
                          </DropdownMenuItem>

                          <DropdownMenuSeparator />

                          {member.status === "ACTIVE" ? (
                            <DropdownMenuItem
                              disabled={isLastOwner}
                              onClick={() =>
                                run(member.membershipId, () =>
                                  setMemberStatusAction(
                                    member.membershipId,
                                    "SUSPENDED",
                                  ),
                                )
                              }
                            >
                              <ShieldOff className="size-4" />
                              Suspend access
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              onClick={() =>
                                run(member.membershipId, () =>
                                  setMemberStatusAction(
                                    member.membershipId,
                                    "ACTIVE",
                                  ),
                                )
                              }
                            >
                              <UserCheck className="size-4" />
                              Restore access
                            </DropdownMenuItem>
                          )}

                          <DropdownMenuItem
                            variant="destructive"
                            disabled={isLastOwner}
                            onClick={() =>
                              run(member.membershipId, () =>
                                setMemberStatusAction(
                                  member.membershipId,
                                  "REVOKED",
                                ),
                              )
                            }
                          >
                            <UserMinus className="size-4" />
                            Remove from business
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Suspending and removing take effect immediately, which is worth
          saying rather than leaving someone to discover it. */}
      {canManage && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Suspending or removing someone signs them out straight away. Changing
          a role also signs them out, so their new permissions take effect on
          their next sign-in rather than whenever their session happens to
          expire.
        </p>
      )}

      <ChangeRoleDialog
        member={editing}
        roles={roles}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          router.refresh();
        }}
        onError={setError}
      />
    </div>
  );
}

function ChangeRoleDialog({
  member,
  roles,
  onClose,
  onSaved,
  onError,
}: {
  member: TeamRow | null;
  roles: RoleOption[];
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [roleId, setRoleId] = React.useState<string>("");
  const [saving, setSaving] = React.useState(false);

  // Reset the selection whenever a different member is opened.
  const memberId = member?.membershipId ?? null;
  const [lastMemberId, setLastMemberId] = React.useState<string | null>(null);
  if (memberId !== lastMemberId) {
    setLastMemberId(memberId);
    setRoleId(member?.roleId ?? "");
  }

  async function save() {
    if (!member) return;
    setSaving(true);
    try {
      const result = await changeMemberRoleAction({
        membershipId: member.membershipId,
        roleId,
        branchId: "",
      });
      if (!result.ok) {
        onError(result.message);
        return;
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={Boolean(member)} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change role</DialogTitle>
          <DialogDescription>
            {member
              ? `Choose what ${member.fullName} can do in this business.`
              : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="change-role-select">Role</Label>
          <Select value={roleId} onValueChange={setRoleId}>
            <SelectTrigger id="change-role-select">
              <SelectValue placeholder="Choose a role" />
            </SelectTrigger>
            <SelectContent>
              {roles.map((role) => (
                <SelectItem key={role.id} value={role.id}>
                  {role.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {roles.find((role) => role.id === roleId)?.description}
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={save}
            loading={saving}
            loadingText="Saving…"
            disabled={!roleId || roleId === member?.roleId}
          >
            Save role
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
