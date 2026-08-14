import type { Metadata } from "next";
import Link from "next/link";
import { CircleCheck, Clock, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { verifyEmailAction } from "@/server/auth/actions";
import { getAuthSession } from "@/server/auth/context";

export const metadata: Metadata = {
  title: "Confirm your email",
  robots: { index: false, follow: false },
};

/**
 * Handles the link from a verification email.
 *
 * Consuming the token on a GET is a deliberate exception to the rule that
 * GETs are side-effect free: an email client cannot issue a POST, and adding a
 * "click here to confirm" button on top of a link the user already clicked is
 * friction with no security benefit — the token is single-use, expiring and
 * unguessable, so a prefetching mail scanner burning it only means the user
 * asks for another.
 */
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const session = await getAuthSession();
  const signedIn = Boolean(session);

  const outcome = token ? await verifyEmailAction(token) : "invalid";

  if (outcome === "verified" || outcome === "already_verified") {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          {outcome === "verified" ? "Email confirmed" : "Already confirmed"}
        </h1>

        <Alert variant="success">
          <CircleCheck />
          <AlertTitle>
            {outcome === "verified"
              ? "Your email address is confirmed"
              : "This address was already confirmed"}
          </AlertTitle>
          <AlertDescription>
            <p>You can now invite team members and manage your subscription.</p>
          </AlertDescription>
        </Alert>

        <Button asChild size="lg" className="w-full">
          <Link href={signedIn ? "/app" : "/login"}>
            {signedIn ? "Go to your dashboard" : "Sign in"}
          </Link>
        </Button>
      </div>
    );
  }

  const expired = outcome === "expired";

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">
        {expired ? "This link has expired" : "This link is not valid"}
      </h1>

      <Alert variant="warning">
        {expired ? <Clock /> : <TriangleAlert />}
        <AlertTitle>
          {expired ? "Confirmation links last 24 hours" : "Nothing to confirm"}
        </AlertTitle>
        <AlertDescription>
          <p>
            {expired
              ? "Sign in and use the banner at the top of your dashboard to send yourself a fresh link."
              : "This link may already have been used, or it may have been copied incompletely from your email."}
          </p>
        </AlertDescription>
      </Alert>

      <Button asChild size="lg" className="w-full">
        <Link href={signedIn ? "/app" : "/login"}>
          {signedIn ? "Back to your dashboard" : "Sign in"}
        </Link>
      </Button>
    </div>
  );
}
