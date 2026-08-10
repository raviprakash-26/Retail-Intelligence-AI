import { NextResponse, type NextRequest } from "next/server";

/**
 * Coarse routing guard.
 *
 * Middleware runs on every matched request, before the database is reachable
 * (Prisma does not run on the Edge runtime). So this checks only for the
 * *presence* of a session cookie and redirects on that basis. It is a
 * convenience that saves rendering a protected page for an obviously
 * signed-out visitor.
 *
 * It is NOT authorization. A forged or expired cookie sails straight through
 * here. Every protected route resolves the session against the database via
 * `requireCompanyContext()`, and that is the check that actually decides.
 * Treating this file as the security boundary would be a serious mistake.
 */

const SESSION_COOKIES = ["__Host-riai_session", "riai_session"] as const;

/** Routes that require a session. */
const PROTECTED_PREFIXES = ["/app", "/onboarding", "/admin"] as const;

/** Auth pages a signed-in user has no reason to see. */
const AUTH_ONLY_PATHS = ["/login", "/register", "/forgot-password"] as const;

function hasSessionCookie(request: NextRequest): boolean {
  return SESSION_COOKIES.some((name) =>
    Boolean(request.cookies.get(name)?.value),
  );
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const signedIn = hasSessionCookie(request);

  if (
    PROTECTED_PREFIXES.some((prefix) => pathname.startsWith(prefix)) &&
    !signedIn
  ) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    // Preserve where they were headed so sign-in returns them there.
    url.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(url);
  }

  if (
    signedIn &&
    AUTH_ONLY_PATHS.includes(pathname as (typeof AUTH_ONLY_PATHS)[number])
  ) {
    const url = request.nextUrl.clone();
    url.pathname = "/app";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and image optimisation, which never
     * need a session check and would only add latency.
     */
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt|sitemap.xml|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico)$).*)",
  ],
};
