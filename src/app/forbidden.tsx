import Link from "next/link";
import { ArrowLeft, ShieldX } from "lucide-react";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";

/**
 * Rendered with a 403 when `forbidden()` is called — a signed-in user reaching
 * something their role does not cover.
 *
 * Deliberately does not name the missing permission. Telling someone exactly
 * which capability they lack maps out the permission model for an account that
 * has already been restricted; "ask an Owner" is the useful half of that
 * information without the reconnaissance.
 */
export default function Forbidden() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-6 text-center">
      <Link href="/" className="mb-10">
        <Logo size="md" />
      </Link>

      <div className="flex size-14 items-center justify-center rounded-2xl bg-warning-muted text-warning-foreground">
        <ShieldX className="size-6" aria-hidden="true" />
      </div>

      <h1 className="mt-6 text-2xl font-semibold tracking-tight">
        You do not have access to this
      </h1>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
        Your role in this business does not include this area. If you need it,
        ask an Owner to adjust your permissions.
      </p>

      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <Button asChild>
          <Link href="/app">
            <ArrowLeft className="size-4" />
            Back to dashboard
          </Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href="/contact">Contact support</Link>
        </Button>
      </div>
    </div>
  );
}
