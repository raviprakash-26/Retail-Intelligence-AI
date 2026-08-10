import "server-only";
import { env } from "@/lib/env";

/**
 * Rate limiting.
 *
 * A fixed-window counter keyed by an arbitrary string. The driver is pluggable
 * so a Redis-backed implementation can replace the in-memory one without any
 * caller changing; `env` refuses to boot a production build on the in-memory
 * driver unless the operator explicitly acknowledges a single-instance deploy.
 *
 * Two independent keys guard every credential endpoint: one per IP address and
 * one per account. IP-only limiting lets a botnet spread an attack on a single
 * account across thousands of addresses; account-only limiting lets one address
 * spray a whole user list. Both are needed.
 */

export type RateLimitResult = {
  allowed: boolean;
  /** Attempts left in the current window. */
  remaining: number;
  /** When the current window resets. */
  resetAt: Date;
  /** Seconds until the window resets — for a Retry-After header. */
  retryAfterSeconds: number;
};

export type RateLimitRule = {
  /** Attempts permitted per window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
};

/**
 * The policy table. Deliberately conservative on credential endpoints: a real
 * person mistyping a password five times in a minute is rare; an attacker
 * doing so is not.
 */
export const RATE_LIMITS = {
  /** Sign-in attempts from one IP address. */
  SIGN_IN_IP: { limit: 20, windowSeconds: 300 },
  /** Sign-in attempts against one email address, from anywhere. */
  SIGN_IN_ACCOUNT: { limit: 8, windowSeconds: 900 },
  /** Registrations from one IP address. */
  REGISTER_IP: { limit: 5, windowSeconds: 3600 },
  /** Password-reset requests from one IP address. */
  PASSWORD_RESET_IP: { limit: 10, windowSeconds: 3600 },
  /** Password-reset requests for one email address. */
  PASSWORD_RESET_ACCOUNT: { limit: 4, windowSeconds: 3600 },
  /** Verification-email resends for one account. */
  RESEND_VERIFICATION: { limit: 4, windowSeconds: 3600 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitName = keyof typeof RATE_LIMITS;

interface RateLimitStore {
  hit(key: string, rule: RateLimitRule): Promise<RateLimitResult>;
  reset(key: string): Promise<void>;
}

type Bucket = { count: number; resetAt: number };

/**
 * Per-process fixed-window store.
 *
 * Correct for a single instance and for tests. Expired buckets are swept
 * opportunistically on write rather than on a timer, so an idle process holds
 * no interval and the map cannot grow without bound under sustained traffic.
 */
class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = Date.now();

  private sweep(now: number): void {
    // Sweeping on every call would be O(n) per request; once a minute is
    // enough to keep the map proportional to active keys.
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  async hit(key: string, rule: RateLimitRule): Promise<RateLimitResult> {
    const now = Date.now();
    this.sweep(now);

    const existing = this.buckets.get(key);
    const bucket =
      existing && existing.resetAt > now
        ? existing
        : { count: 0, resetAt: now + rule.windowSeconds * 1000 };

    bucket.count += 1;
    this.buckets.set(key, bucket);

    const allowed = bucket.count <= rule.limit;
    return {
      allowed,
      remaining: Math.max(0, rule.limit - bucket.count),
      resetAt: new Date(bucket.resetAt),
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  async reset(key: string): Promise<void> {
    this.buckets.delete(key);
  }
}

const globalForRateLimit = globalThis as unknown as {
  rateLimitStore: RateLimitStore | undefined;
};

function store(): RateLimitStore {
  // Survives hot reload in development, the same reason the Prisma client does.
  globalForRateLimit.rateLimitStore ??= new MemoryRateLimitStore();
  return globalForRateLimit.rateLimitStore;
}

/**
 * Record an attempt and report whether it is permitted.
 *
 * `identifier` is the thing being limited — an IP address, or a lowercased
 * email. It is namespaced by the rule so the same IP has separate budgets for
 * signing in and for registering.
 */
export async function checkRateLimit(
  name: RateLimitName,
  identifier: string,
): Promise<RateLimitResult> {
  const rule = RATE_LIMITS[name];
  return store().hit(`${name}:${identifier}`, rule);
}

/** Clear a counter. Called after a successful sign-in. */
export async function clearRateLimit(
  name: RateLimitName,
  identifier: string,
): Promise<void> {
  await store().reset(`${name}:${identifier}`);
}

/** Test-only: drop all counters so cases do not leak into each other. */
export function resetAllRateLimitsForTests(): void {
  globalForRateLimit.rateLimitStore = new MemoryRateLimitStore();
}

export function rateLimitDriver(): string {
  return env.RATE_LIMIT_DRIVER;
}
