import { requireCompanyContext } from "@/server/auth/context";

/**
 * Authenticated application shell.
 *
 * `requireCompanyContext()` is the real authorization boundary — middleware
 * only checked that a cookie existed. Resolving it here means every page under
 * this layout is guaranteed a valid session, an active membership and a
 * company, and none of them has to re-check.
 *
 * Phase 4 replaces this with the full shell (sidebar, top bar, search,
 * financial-year selector). Until then it is a plain container so the
 * authentication work can be exercised end to end.
 */
export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  await requireCompanyContext();

  return <div className="min-h-dvh bg-muted/30">{children}</div>;
}
