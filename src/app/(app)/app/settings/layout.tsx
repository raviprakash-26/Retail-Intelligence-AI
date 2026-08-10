import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { SettingsNav } from "@/components/settings/settings-nav";
import { requireCompanyContext } from "@/server/auth/context";

export default async function SettingsLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const context = await requireCompanyContext();

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6">
      <Link
        href="/app"
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        <ArrowLeft className="size-3.5" />
        Back to dashboard
      </Link>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {context.company.name}
        </p>
      </header>

      <SettingsNav permissions={[...context.permissions]} />

      <div className="pt-8">{children}</div>
    </div>
  );
}
