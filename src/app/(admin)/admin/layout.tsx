import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { AdminNav } from "@/components/admin/admin-nav";
import { ADMIN_SCOPE_NOTE } from "@/lib/admin/scope";
import { requirePlatformAdmin } from "@/server/auth/context";

/**
 * The platform administration area.
 *
 * Deliberately not inside the tenant shell. The application shell is built
 * around a company context — a sidebar of that business's modules, its fiscal
 * year, its notifications — and administration has none of those. Bolting an
 * admin section onto it would mean an administrator is always looking at some
 * tenant's chrome, which is exactly the confusion that ends with somebody
 * acting on the wrong account.
 *
 * The role is checked here and again in every action. This layout is a
 * rendering decision; the actions are what anybody could post to directly.
 */
export default async function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await requirePlatformAdmin();

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <ShieldAlert className="size-4" />
            <span className="text-sm font-semibold">
              Platform administration
            </span>
          </div>
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span>{session.user.email}</span>
            <Link href="/app" className="underline-offset-4 hover:underline">
              Back to the application
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
        <AdminNav />

        <p className="mt-4 rounded-lg border border-dashed px-4 py-3 text-xs leading-relaxed text-muted-foreground">
          {ADMIN_SCOPE_NOTE}
        </p>

        <main className="pt-6">{children}</main>
      </div>
    </div>
  );
}
