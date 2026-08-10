import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Building2, LogOut } from "lucide-react";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { signOutAction } from "@/server/auth/actions";
import { getCompanyContext, requireAuth } from "@/server/auth/context";

export const metadata: Metadata = {
  title: "Set up your business",
  robots: { index: false, follow: false },
};

/**
 * Where a signed-in user with no company lands.
 *
 * Reachable today only in edge cases — a user whose membership was revoked, or
 * whose only company was cancelled — because registration creates a company in
 * the same transaction as the account. Phase 3 turns this into the full
 * onboarding flow.
 */
export default async function OnboardingPage() {
  await requireAuth("/onboarding");

  // A user who does have a company has no business here.
  const context = await getCompanyContext();
  if (context) redirect("/app");

  return (
    <div className="mx-auto w-full max-w-lg px-4 py-16 sm:px-6">
      <Logo size="md" className="mb-10" />

      <Card>
        <CardHeader>
          <div className="flex size-11 items-center justify-center rounded-xl bg-primary-muted text-primary">
            <Building2 className="size-5" />
          </div>
          <CardTitle className="mt-3.5">
            No business linked to this account
          </CardTitle>
          <CardDescription>
            Your sign-in works, but you are not currently an active member of
            any business. That usually means your access was removed, or the
            business was closed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            If you were expecting access, ask the business owner to re-invite
            you. Otherwise you can create a new business — full setup arrives in
            the next phase of the build.
          </p>
          <form action={signOutAction}>
            <Button type="submit" variant="outline" className="w-full">
              <LogOut className="size-4" />
              Sign out
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
