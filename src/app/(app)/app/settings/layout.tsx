import { SettingsNav } from "@/components/settings/settings-nav";
import { requireCompanyContext } from "@/server/auth/context";

export default async function SettingsLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const context = await requireCompanyContext();

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {context.company.name}
        </p>
      </header>

      <SettingsNav permissions={[...context.permissions]} />

      <div className="pt-8">{children}</div>
    </div>
  );
}
