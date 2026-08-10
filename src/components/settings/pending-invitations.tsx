"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Clock, MailX } from "lucide-react";
import { FormError } from "@/components/auth/form-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatRelativeTime } from "@/lib/format";
import { revokeInvitationAction } from "@/server/company/actions";

export type InvitationRow = {
  id: string;
  email: string;
  fullName: string;
  roleName: string;
  expiresAt: string;
  expired: boolean;
};

export function PendingInvitations({
  invitations,
  canManage,
}: {
  invitations: InvitationRow[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<string | null>(null);

  if (invitations.length === 0) return null;

  async function revoke(id: string) {
    setError(null);
    setPending(id);
    try {
      const result = await revokeInvitationAction(id);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Pending invitations</CardTitle>
        <CardDescription>
          Sent but not yet accepted. Withdrawing one makes its link stop working
          immediately.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <FormError message={error} />

        <ul className="divide-y rounded-lg border">
          {invitations.map((invitation) => (
            <li
              key={invitation.id}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">{invitation.fullName}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {invitation.email}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="muted">{invitation.roleName}</Badge>
                {invitation.expired ? (
                  <Badge variant="danger">Expired</Badge>
                ) : (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="size-3" />
                    Expires {formatRelativeTime(invitation.expiresAt)}
                  </span>
                )}
                {canManage && (
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={pending === invitation.id}
                    onClick={() => revoke(invitation.id)}
                  >
                    <MailX className="size-4" />
                    Withdraw
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
