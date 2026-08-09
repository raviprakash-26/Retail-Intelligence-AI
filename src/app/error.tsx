"use client";

import * as React from "react";
import Link from "next/link";
import { RotateCcw, TriangleAlert } from "lucide-react";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";

/**
 * Route-level error boundary.
 *
 * Deliberately does not render `error.message`: a server-side failure message
 * can carry a query fragment, a constraint name or a record identifier, and
 * this screen is shown to end users. The digest is displayed instead so a
 * support conversation can correlate it with the server log.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error("Unhandled application error", error);
  }, [error]);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-6 text-center">
      <Link href="/" className="mb-10">
        <Logo size="md" />
      </Link>

      <div className="flex size-14 items-center justify-center rounded-2xl bg-destructive-muted text-destructive">
        <TriangleAlert className="size-6" aria-hidden="true" />
      </div>

      <h1 className="mt-6 text-2xl font-semibold tracking-tight">
        Something went wrong
      </h1>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
        This request could not be completed. No transaction was recorded, and no
        data has been changed.
      </p>

      {error.digest && (
        <p className="mt-4 font-mono text-xs text-muted-foreground">
          Reference: {error.digest}
        </p>
      )}

      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <Button onClick={reset}>
          <RotateCcw className="size-4" />
          Try again
        </Button>
        <Button variant="outline" asChild>
          <Link href="/contact">Contact support</Link>
        </Button>
      </div>
    </div>
  );
}
