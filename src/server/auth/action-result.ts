/**
 * The shape every server action returns.
 *
 * Actions never throw for expected failures — a wrong password is not an
 * exception, it is an outcome the form has to render. Field errors are keyed
 * by form path so react-hook-form can attach them to the right input.
 */
export type ActionResult<T = void> =
  | { ok: true; data: T }
  | {
      ok: false;
      /** Message shown at the top of the form. */
      message: string;
      /** Per-field messages, keyed by the form field path. */
      fieldErrors?: Record<string, string>;
      /** Machine-readable reason, for the client to branch on. */
      code?: string;
      /** Seconds to wait, when the failure is a rate limit. */
      retryAfterSeconds?: number;
    };

export function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

export function fail(
  message: string,
  options: {
    fieldErrors?: Record<string, string>;
    code?: string;
    retryAfterSeconds?: number;
  } = {},
): ActionResult<never> {
  return { ok: false, message, ...options };
}

export const ACTION_ERROR = {
  INVALID_INPUT: "INVALID_INPUT",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  RATE_LIMITED: "RATE_LIMITED",
  ACCOUNT_LOCKED: "ACCOUNT_LOCKED",
  ACCOUNT_SUSPENDED: "ACCOUNT_SUSPENDED",
  EMAIL_TAKEN: "EMAIL_TAKEN",
  TOKEN_INVALID: "TOKEN_INVALID",
  NOT_AUTHENTICATED: "NOT_AUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  /** The plan does not include it. Distinct from FORBIDDEN, which is a role. */
  FEATURE_NOT_INCLUDED: "FEATURE_NOT_INCLUDED",
  /** The subscription has lapsed: nothing new may be posted. */
  SUBSCRIPTION_READ_ONLY: "SUBSCRIPTION_READ_ONLY",
  /** A numeric allowance on the plan is used up. */
  PLAN_LIMIT_REACHED: "PLAN_LIMIT_REACHED",
  UNEXPECTED: "UNEXPECTED",
} as const;

/**
 * Turns a Zod error into field messages the form can render.
 * Nested paths are dotted (`account.email`) to match the form's field names.
 */
export function zodFieldErrors(
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.map(String).join(".");
    // Keep the first message per field: a cascade of messages on one input is
    // noise, and the first is almost always the actionable one.
    if (key && !result[key]) result[key] = issue.message;
  }
  return result;
}

/**
 * Validates a post-authentication redirect target.
 *
 * Only same-site absolute paths are allowed. `//evil.example` and
 * `https://evil.example` are both rejected — the first is a protocol-relative
 * URL that browsers treat as absolute, and it is the classic open-redirect
 * bypass.
 */
export function safeRedirectPath(
  next: string | null | undefined,
  fallback = "/app",
): string {
  if (!next) return fallback;
  if (!next.startsWith("/")) return fallback;
  if (next.startsWith("//")) return fallback;
  if (next.includes("\\")) return fallback;
  // Reject anything that parses as absolute against a dummy base with a
  // different origin.
  try {
    const parsed = new URL(next, "https://placeholder.invalid");
    if (parsed.origin !== "https://placeholder.invalid") return fallback;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return fallback;
  }
}
