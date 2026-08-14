"use client";

import * as React from "react";
import Link from "next/link";
import { RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * Error boundary inside the shell.
 *
 * Sits below the layout, so the sidebar and top bar stay usable and the person
 * is not thrown out to a bare error page with no way back.
 *
 * The message itself is never rendered: a server-side failure can carry a
 * query fragment, a constraint name or a record id, and this screen is shown to
 * end users. The digest correlates it with the server log instead.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error("Application error", error);
  }, [error]);

  return (
    <div className="mx-auto w-full max-w-lg px-4 py-16 sm:px-6">
      <Card>
        <CardHeader>
          <div className="flex size-11 items-center justify-center rounded-xl bg-destructive-muted text-destructive">
            <TriangleAlert className="size-5" aria-hidden="true" />
          </div>
          <CardTitle className="mt-3.5">Something went wrong</CardTitle>
          <CardDescription className="mt-1.5">
            This page could not be loaded. No transaction was recorded and no
            data has been changed.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {error.digest && (
            <p className="font-mono text-xs text-muted-foreground">
              Reference: {error.digest}
            </p>
          )}

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button onClick={reset}>
              <RotateCcw className="size-4" />
              Try again
            </Button>
            <Button variant="outline" asChild>
              <Link href="/app">Back to dashboard</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
