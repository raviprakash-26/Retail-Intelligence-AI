import type { Metadata } from "next";
import Link from "next/link";
import { Building2, TriangleAlert } from "lucide-react";
import { AcceptInvitationForm } from "@/components/auth/accept-invitation-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { previewInvitation } from "@/server/company/team-service";

export const metadata: Metadata = {
  title: "Join a business",
  robots: { index: false, follow: false },
};

export default async function InvitationPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const invitation = token ? await previewInvitation(token) : null;

  if (!token || !invitation) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          This invitation is not valid
        </h1>

        <Alert variant="warning">
          <TriangleAlert />
          <AlertTitle>Nothing to accept</AlertTitle>
          <AlertDescription>
            <p>
              Invitations expire after 7 days and can only be used once. This
              one may have already been accepted, or withdrawn by the person who
              sent it.
            </p>
            <p>Ask them to send you a new invitation.</p>
          </AlertDescription>
        </Alert>

        <Button asChild variant="outline" size="lg" className="w-full">
          <Link href="/login">Go to sign in</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <div className="flex size-11 items-center justify-center rounded-xl bg-primary-muted text-primary">
          <Building2 className="size-5" />
        </div>

        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            Join {invitation.companyName}
          </h1>
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            You have been invited as
            <Badge variant="muted">{invitation.roleName}</Badge>
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            This invitation is for{" "}
            <span className="font-medium text-foreground">
              {invitation.email}
            </span>
            .
          </p>
        </div>
      </div>

      <AcceptInvitationForm
        token={token}
        fullName={invitation.fullName}
        hasAccount={invitation.hasAccount}
      />

      <p className="text-xs leading-relaxed text-muted-foreground">
        Your role decides what you can see and do. It was set by whoever invited
        you and can only be changed by them.
      </p>
    </div>
  );
}
