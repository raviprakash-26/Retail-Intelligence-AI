import Link from "next/link";
import { LogIn } from "lucide-react";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";

/**
 * Rendered with a 401 when `unauthorized()` is called — no valid session where
 * one was required.
 *
 * Most protected routes redirect to sign-in instead; this covers the paths
 * that cannot redirect, such as a server action invoked after a session was
 * revoked mid-visit.
 */
export default function Unauthorized() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-6 text-center">
      <Link href="/" className="mb-10">
        <Logo size="md" />
      </Link>

      <div className="flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        <LogIn className="size-6" aria-hidden="true" />
      </div>

      <h1 className="mt-6 text-2xl font-semibold tracking-tight">
        Please sign in to continue
      </h1>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
        Your session has ended. Signing in again will bring you straight back.
      </p>

      <Button asChild className="mt-8">
        <Link href="/login">Sign in</Link>
      </Button>
    </div>
  );
}
