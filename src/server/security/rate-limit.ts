import "server-only";
import { createClient, type RedisClientType } from "redis";
import { env } from "@/lib/env";
import { logger } from "@/lib/observability/logger";
import { incrementCounter } from "@/lib/observability/metrics";

/**
 * Rate limiting.
 *
 * A fixed-window counter keyed by an arbitrary string. Two drivers: an
 * in-process map, correct for one instance and for tests, and a Redis-backed
 * one that several instances share. `env` refuses to boot a production build on
 * the in-memory driver unless the operator explicitly acknowledges a
 * single-instance deploy, because a limiter that silently counts per-replica is
 * a limiter with N times the budget somebody configured.
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
  /**
   * Questions to the assistant, per user.
   *
   * The monthly allowance on the plan is the commercial limit; this is the
   * safety one. A loop calling the action a thousand times in a minute spends
   * real money at the provider before the monthly count catches up, and the
   * person it charges is us.
   */
  AI_MESSAGE_USER: { limit: 20, windowSeconds: 60 },
  /** Invitations sent from one company. Email sent to strangers, so capped. */
  INVITE_COMPANY: { limit: 20, windowSeconds: 3600 },
  /**
   * Complete data exports, per user.
   *
   * The most expensive thing this application can be asked to do — it reads
   * every row of every table the business owns. Three an hour is more than
   * anybody needs and few enough that a loop cannot use the shop's own
   * database against it.
   */
  DATA_EXPORT_USER: { limit: 3, windowSeconds: 3600 },
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

/**
 * Redis-backed fixed-window store.
 *
 * The counter has to be incremented and given a lifetime atomically. Doing it
 * as two commands leaves a window in which the process dies after INCR and
 * before EXPIRE — and a counter with no expiry never resets, so that identifier
 * is locked out permanently. One script, one round trip, no window.
 *
 * The script also returns the remaining TTL, because the caller needs to say
 * *when* the limit lifts and a second command to read it would be another round
 * trip on the hot path of every sign-in.
 */
const HIT_SCRIPT = `
  local current = redis.call('INCR', KEYS[1])
  if current == 1 then
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
  end
  return {current, redis.call('PTTL', KEYS[1])}
`;

/**
 * How long a rate-limit check may take before it is treated as unavailable.
 *
 * This sits on the sign-in path. A check that takes longer than this has
 * already cost more than it is worth, and — the failure that made this
 * necessary — node-redis retries a dead server indefinitely by default, so
 * `connect()` never rejects and a request would wait forever rather than
 * falling back. The fallback below is only reachable because of this bound.
 */
const CHECK_TIMEOUT_MS = 1_000;

/** Rejects if `work` has not settled in time, so no caller waits unbounded. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class RedisRateLimitStore implements RateLimitStore {
  private client: RedisClientType | undefined;
  private connecting: Promise<RedisClientType> | undefined;

  /** Defaults to the configured server; a test may point it somewhere else. */
  constructor(private readonly url: string | undefined = env.REDIS_URL) {}

  private async connection(): Promise<RedisClientType> {
    if (this.client?.isReady) return this.client;

    // One connection attempt in flight at a time: a burst of sign-ins during a
    // reconnect must not open a socket each. The attempt is itself bounded, and
    // clearing `connecting` when it settles is what lets the next request try
    // again rather than inheriting a promise that will never resolve.
    this.connecting ??= withTimeout(
      (async () => {
        const client: RedisClientType = createClient({
          url: this.url,
          socket: {
            connectTimeout: CHECK_TIMEOUT_MS,
            // Keep reconnecting so the limiter recovers on its own, but with a
            // capped delay rather than an ever-growing one.
            reconnectStrategy: (attempts) => Math.min(attempts * 200, 5_000),
          },
        });
        // node-redis emits `error` on every failed reconnect; without a
        // listener that becomes an unhandled exception and takes the process
        // down — turning a Redis outage into an application outage.
        client.on("error", (error: unknown) => {
          logger.warn("Redis connection error", { module: "RateLimit", error });
        });
        await client.connect();
        this.client = client;
        return client;
      })(),
      CHECK_TIMEOUT_MS,
    ).finally(() => {
      this.connecting = undefined;
    });

    return this.connecting;
  }

  async hit(key: string, rule: RateLimitRule): Promise<RateLimitResult> {
    const windowMs = rule.windowSeconds * 1000;

    try {
      const [count, ttl] = await withTimeout(
        (async () => {
          const client = await this.connection();
          return (await client.eval(HIT_SCRIPT, {
            keys: [`ratelimit:${key}`],
            arguments: [String(windowMs)],
          })) as [number, number];
        })(),
        CHECK_TIMEOUT_MS,
      );

      const remainingMs = ttl > 0 ? ttl : windowMs;
      return {
        allowed: count <= rule.limit,
        remaining: Math.max(0, rule.limit - count),
        resetAt: new Date(Date.now() + remainingMs),
        retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
      };
    } catch (error) {
      return this.unavailable(error, rule, windowMs);
    }
  }

  /**
   * What to do when Redis cannot be reached.
   *
   * It allows the attempt, and that is a deliberate trade rather than an
   * oversight. Failing closed would mean a Redis blip locks every customer out
   * of signing in — a total outage of the product to protect one control. So
   * the request proceeds, and the failure is made loud instead of silent: an
   * error in the log and a counter an operator can alert on. A rate limiter
   * that has quietly stopped working is the thing worth preventing here, and
   * that is exactly what the alert is for.
   */
  private unavailable(
    error: unknown,
    rule: RateLimitRule,
    windowMs: number,
  ): RateLimitResult {
    logger.error("Rate limit check failed; allowing the request", {
      module: "RateLimit",
      error,
    });
    incrementCounter(
      "riai_rate_limit_unavailable_total",
      "Rate limit checks that could not reach Redis and were allowed through.",
    );

    return {
      allowed: true,
      remaining: rule.limit,
      resetAt: new Date(Date.now() + windowMs),
      retryAfterSeconds: Math.ceil(windowMs / 1000),
    };
  }

  async reset(key: string): Promise<void> {
    try {
      const client = await this.connection();
      await withTimeout(client.del(`ratelimit:${key}`), CHECK_TIMEOUT_MS);
    } catch (error) {
      // Clearing a counter is a courtesy after a successful sign-in, never a
      // correctness requirement — the window expires on its own.
      logger.warn("Could not clear a rate limit counter", {
        module: "RateLimit",
        error,
      });
    }
  }
}

/**
 * Test-only: a store pointed at a server of the test's choosing.
 *
 * Exists so the fail-open path can be exercised against an address nothing is
 * listening on. That path was broken when it was written — node-redis retries
 * indefinitely, so the fallback was unreachable and a request would have hung
 * — and a documented behaviour nobody can test is how it stayed broken.
 */
export function redisStoreForTests(url: string): RateLimitStore {
  return new RedisRateLimitStore(url);
}

const globalForRateLimit = globalThis as unknown as {
  rateLimitStore: RateLimitStore | undefined;
};

function store(): RateLimitStore {
  // Survives hot reload in development, the same reason the Prisma client does.
  globalForRateLimit.rateLimitStore ??=
    env.RATE_LIMIT_DRIVER === "redis"
      ? new RedisRateLimitStore()
      : new MemoryRateLimitStore();
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
