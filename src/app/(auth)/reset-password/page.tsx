import type { Metadata } from "next";
import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Set a new password",
  robots: { index: false, follow: false },
};

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  // A reset link without a token cannot be honoured. Say so rather than
  // presenting a form that is guaranteed to fail on submit.
  if (!token) {
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            This link is not valid
          </h1>
        </div>

        <Alert variant="warning">
          <TriangleAlert />
          <AlertTitle>Missing reset token</AlertTitle>
          <AlertDescription>
            <p>
              Password reset links expire after one hour and can only be used
              once. Request a new one to continue.
            </p>
          </AlertDescription>
        </Alert>

        <Button asChild className="w-full" size="lg">
          <Link href="/forgot-password">Request a new link</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Set a new password
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Choose a password you do not use anywhere else.
        </p>
      </div>

      <ResetPasswordForm token={token} />
    </div>
  );
}
