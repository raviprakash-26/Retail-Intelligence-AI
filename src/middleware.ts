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

/**
 * Content-Security-Policy.
 *
 * Two policies, because Next.js makes one impossible. A nonce is the right way
 * to allow the framework's own inline bootstrap without allowing every injected
 * script — but a statically prerendered page has its inline scripts written at
 * build time, months before any request, and nothing can stamp a per-request
 * nonce onto them. A nonce policy on those pages does not harden them; it
 * breaks them, which the end-to-end run demonstrated by rendering a sign-in
 * page with no working form.
 *
 * So the strict policy goes where the data is. Every page under /app, /admin
 * and /onboarding is rendered per request — they all read a session cookie —
 * and those get the nonce. The public marketing and sign-in pages are static
 * and get `unsafe-inline` for scripts, which is worth less, but they render no
 * tenant data and hold no session.
 *
 * `strict-dynamic` is deliberately absent even on the strict policy: it makes
 * the browser ignore `'self'`, and Next's own chunks are same-origin `src`
 * tags without nonces. With it, nothing loads at all.
 *
 * `style-src` allows inline everywhere. Tailwind ships a stylesheet, but Next
 * and several primitives set style attributes directly and there is no honest
 * way to nonce those today. Written down rather than left to be discovered,
 * because a policy nobody can explain is one somebody widens.
 *
 * One thing is knowingly blocked by the strict policy: the pre-paint script
 * next-themes injects, which reads the stored theme before the first frame. It
 * lives in the root layout, which is shared with the static marketing pages, so
 * giving it a nonce would mean reading request headers there and making every
 * page in the product dynamic — a real cost to avoid a flash of the light theme
 * for dark-mode users. The end-to-end run asserts that this is the *only* thing
 * blocked, so anything else that starts failing fails loudly. If the layout tree
 * is ever split so the application area has its own provider, pass it the nonce
 * from `x-nonce` and the exception goes away.
 */
const STRICT_PREFIXES = ["/app", "/admin", "/onboarding"] as const;

/**
 * Hosts the Razorpay checkout widget needs, and nothing else.
 *
 * Card details must never touch this server, which means the payment form has
 * to be the provider's own — and their script and iframe have to be allowed
 * through the policy for that to work. This is a genuine widening of the
 * policy, so it is applied **only where payments are switched on**: an
 * installation that takes no money keeps the tighter policy it has today
 * rather than inheriting a hole for a feature it never uses.
 *
 * Read from `process.env` directly rather than through the validated `env`
 * module: middleware runs on the edge runtime, where importing the server-side
 * environment schema would pull in far more than belongs there.
 */
const RAZORPAY_HOSTS = {
  script: ["https://checkout.razorpay.com"],
  frame: ["https://api.razorpay.com", "https://checkout.razorpay.com"],
  connect: ["https://api.razorpay.com", "https://lumberjack.razorpay.com"],
} as const;

function paymentsEnabled(): boolean {
  return process.env.PAYMENTS_DRIVER === "razorpay";
}

function contentSecurityPolicy(params: {
  nonce: string;
  strict: boolean;
  development: boolean;
  payments: boolean;
}): string {
  const script = params.strict
    ? `'self' 'nonce-${params.nonce}'`
    : "'self' 'unsafe-inline'";

  const extra = (hosts: readonly string[]) =>
    params.payments ? ` ${hosts.join(" ")}` : "";

  return [
    "default-src 'self'",
    // The dev server needs eval for fast refresh. Production never gets it.
    `script-src ${script}${params.development ? " 'unsafe-eval'" : ""}${extra(RAZORPAY_HOSTS.script)}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // Every outbound call the product makes — the AI provider, the payment
    // gateway's API — is made by the server. The browser talks only to us, and
    // to the checkout widget where one is configured.
    `connect-src 'self'${extra(RAZORPAY_HOSTS.connect)}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // The checkout itself is an iframe served by the provider. Without this it
    // is blocked and the payment cannot be made at all.
    `frame-src 'self'${extra(RAZORPAY_HOSTS.frame)}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    ...(params.development ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const signedIn = hasSessionCookie(request);

  const nonce = crypto.randomUUID().replace(/-/g, "");
  const policy = contentSecurityPolicy({
    nonce,
    strict: STRICT_PREFIXES.some((prefix) => pathname.startsWith(prefix)),
    development: process.env.NODE_ENV !== "production",
    payments: paymentsEnabled(),
  });

  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", policy);

  if (
    PROTECTED_PREFIXES.some((prefix) => pathname.startsWith(prefix)) &&
    !signedIn
  ) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    // Preserve where they were headed so sign-in returns them there.
    url.searchParams.set("next", `${pathname}${search}`);
    return withPolicy(NextResponse.redirect(url), policy);
  }

  if (
    signedIn &&
    AUTH_ONLY_PATHS.includes(pathname as (typeof AUTH_ONLY_PATHS)[number])
  ) {
    const url = request.nextUrl.clone();
    url.pathname = "/app";
    url.search = "";
    return withPolicy(NextResponse.redirect(url), policy);
  }

  return withPolicy(NextResponse.next({ request: { headers } }), policy);
}

/** Every response leaves here with the policy on it, redirects included. */
function withPolicy(response: NextResponse, policy: string): NextResponse {
  response.headers.set("content-security-policy", policy);
  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and image optimisation, which never
     * need a session check and would only add latency.
     *
     * The health and readiness probes are excluded too. An orchestrator hits
     * them every few seconds, they carry no session and render no HTML, and a
     * probe that runs through the same pipeline it is meant to observe is a
     * probe that cannot tell you that pipeline is broken.
     */
    "/((?!_next/static|_next/image|api/health|api/ready|favicon.ico|icon.svg|robots.txt|sitemap.xml|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico)$).*)",
  ],
};
