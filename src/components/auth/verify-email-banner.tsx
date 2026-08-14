"use client";

import * as React from "react";
import { MailWarning } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { resendVerificationAction } from "@/server/auth/actions";

/**
 * Prompt shown until a new account confirms its email address.
 *
 * A prompt rather than a wall: locking a retailer out of their own books until
 * an email arrives is how you lose them in the first five minutes. Verification
 * gates the operations where an unconfirmed address is actually dangerous —
 * inviting team members and changing billing.
 */
export function VerifyEmailBanner({ email }: { email: string }) {
  const [state, setState] = React.useState<
    "idle" | "sending" | "sent" | "error"
  >("idle");
  const [message, setMessage] = React.useState<string | null>(null);

  async function resend() {
    setState("sending");
    const result = await resendVerificationAction();
    if (result.ok) {
      setState("sent");
      setMessage(null);
    } else {
      setState("error");
      setMessage(result.message);
    }
  }

  return (
    <Alert variant="warning">
      <MailWarning />
      <AlertTitle>Confirm your email address</AlertTitle>
      <AlertDescription>
        <p>
          We sent a confirmation link to <strong>{email}</strong>. You can carry
          on using the app — confirming unlocks inviting your team and managing
          billing.
        </p>
        <div
          className="flex flex-wrap items-center gap-3 pt-1"
          aria-live="polite"
        >
          {state === "sent" ? (
            <span className="text-xs font-medium">
              Sent. Check your inbox and spam folder.
            </span>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={resend}
              loading={state === "sending"}
              loadingText="Sending…"
            >
              Resend the link
            </Button>
          )}
          {message && <span className="text-xs">{message}</span>}
        </div>
      </AlertDescription>
    </Alert>
  );
}
