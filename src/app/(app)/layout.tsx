import { requireAuth } from "@/server/auth/context";

/**
 * Authenticated area.
 *
 * Requires a session and nothing more. Requiring a *company* here would be a
 * redirect loop: `requireCompanyContext()` sends a user with no membership to
 * `/onboarding`, which lives inside this group and would then bounce them
 * straight back. The company requirement therefore belongs one level down, in
 * `app/layout.tsx`, alongside the shell that actually needs it.
 */
export default async function AuthenticatedLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  await requireAuth();
  return children;
}
