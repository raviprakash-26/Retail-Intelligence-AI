import "server-only";
import { headers } from "next/headers";
import { forbidden } from "next/navigation";
import { env } from "@/lib/env";
import {
  ACTION_ERROR,
  fail,
  type ActionResult,
} from "@/server/auth/action-result";

/**
 * Facts about the current request, used for audit logging and rate limiting.
 */

export type RequestContext = {
  ipAddress: string | null;
  userAgent: string | null;
  origin: string | null;
  /** The host the browser actually addressed, after proxy rewriting. */
  host: string | null;
};

/**
 * Best-effort client IP.
 *
 * `x-forwarded-for` is client-controlled unless a trusted proxy overwrites it,
 * so the *leftmost* entry is not automatically the real client. We take the
 * leftmost value because the deployment is expected to sit behind a proxy that
 * rewrites the header; where that is not true, rate limiting degrades to
 * per-spoofed-value rather than failing open, because an attacker rotating the
 * header still faces the per-account limit.
 */
export async function getRequestContext(): Promise<RequestContext> {
  const headerList = await headers();

  const forwarded = headerList.get("x-forwarded-for");
  const ipAddress =
    headerList.get("cf-connecting-ip") ??
    headerList.get("x-real-ip") ??
    forwarded?.split(",")[0]?.trim() ??
    null;

  return {
    ipAddress: ipAddress && ipAddress.length <= 45 ? ipAddress : null,
    userAgent: headerList.get("user-agent")?.slice(0, 512) ?? null,
    origin: headerList.get("origin"),
    host: headerList.get("x-forwarded-host") ?? headerList.get("host"),
  };
}

/** Falls back to a constant so a missing IP cannot bypass rate limiting. */
export function rateLimitKey(ipAddress: string | null): string {
  return ipAddress ?? "unknown-ip";
}

/**
 * Rejects a state-changing request whose Origin is not this application.
 *
 * The comparison is against the host the request was actually addressed to,
 * not only the configured `APP_URL`. That is what makes the check both correct
 * and deployment-agnostic:
 *
 *   • Correct — CSRF is an attacker's page POSTing to us. The browser stamps
 *     the *attacker's* origin on that request, which can never equal the host
 *     the request arrived on, whatever `APP_URL` happens to say.
 *   • Deployment-agnostic — a preview URL, a proxy, an alternate port or a
 *     custom domain would otherwise fail every action until someone noticed
 *     and updated `APP_URL`.
 *
 * `APP_URL` is still accepted, so a proxy that rewrites Origin but not Host
 * (or the reverse) does not lock users out.
 *
 * Next.js applies its own origin check to Server Actions; this is a second,
 * explicit layer that also covers route handlers.
 */
export function isSameOrigin(
  origin: string | null,
  host?: string | null,
): boolean {
  // Same-origin form posts and non-browser clients may omit Origin entirely.
  // A cross-site POST from a browser always carries it.
  if (!origin) return true;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }

  if (host && originHost === host) return true;

  try {
    return originHost === new URL(env.APP_URL).host;
  } catch {
    return false;
  }
}

/**
 * The origin check every state-changing action makes.
 *
 * One function with one name, rather than a `guardOrigin` here and a `guard`
 * there and an inline `isSameOrigin` somewhere else. That mattered enough to
 * standardise: the coverage test can only assert what it can recognise, and
 * three spellings of the same check is how one of them quietly stops being
 * made. Returns a failed result to render, or null to carry on.
 *
 * Read-only actions do not need it — a cross-origin page can cause a request
 * but cannot read the response — but they are named in the coverage test
 * rather than left to be inferred from the absence of a call.
 */
export async function requireSameOrigin(): Promise<ActionResult<never> | null> {
  const { origin, host } = await getRequestContext();
  if (isSameOrigin(origin, host)) return null;

  return fail("That request did not look right.", {
    code: ACTION_ERROR.FORBIDDEN,
  });
}

/**
 * The same check, for actions that redirect or return their own shape.
 *
 * Not every action returns an `ActionResult` — signing out redirects, switching
 * business redirects, and a couple return a small bespoke object. Those cannot
 * render a failed result, so this interrupts with a 403 instead. The check
 * itself is identical; only what happens afterwards differs.
 */
export async function assertSameOrigin(): Promise<void> {
  const { origin, host } = await getRequestContext();
  if (!isSameOrigin(origin, host)) forbidden();
}
