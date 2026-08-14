import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RATE_LIMITS,
  checkRateLimit,
  clearRateLimit,
  resetAllRateLimitsForTests,
} from "@/server/security/rate-limit";

describe("rate limiting", () => {
  beforeEach(() => {
    resetAllRateLimitsForTests();
    vi.useRealTimers();
  });

  it("allows attempts up to the limit and blocks the next one", async () => {
    const { limit } = RATE_LIMITS.SIGN_IN_ACCOUNT;

    for (let attempt = 1; attempt <= limit; attempt += 1) {
      const result = await checkRateLimit("SIGN_IN_ACCOUNT", "a@example.com");
      expect(result.allowed, `attempt ${attempt}`).toBe(true);
      expect(result.remaining).toBe(limit - attempt);
    }

    const blocked = await checkRateLimit("SIGN_IN_ACCOUNT", "a@example.com");
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("keeps separate budgets per identifier", async () => {
    const { limit } = RATE_LIMITS.SIGN_IN_ACCOUNT;

    for (let attempt = 0; attempt < limit + 2; attempt += 1) {
      await checkRateLimit("SIGN_IN_ACCOUNT", "victim@example.com");
    }

    // Another account must be unaffected by the first being hammered.
    const other = await checkRateLimit(
      "SIGN_IN_ACCOUNT",
      "bystander@example.com",
    );
    expect(other.allowed).toBe(true);
  });

  it("keeps separate budgets per rule for the same identifier", async () => {
    const { limit } = RATE_LIMITS.SIGN_IN_IP;
    for (let attempt = 0; attempt < limit + 1; attempt += 1) {
      await checkRateLimit("SIGN_IN_IP", "203.0.113.9");
    }

    expect((await checkRateLimit("SIGN_IN_IP", "203.0.113.9")).allowed).toBe(
      false,
    );
    // Exhausting the sign-in budget must not block registration from that IP.
    expect((await checkRateLimit("REGISTER_IP", "203.0.113.9")).allowed).toBe(
      true,
    );
  });

  it("clears a counter on request", async () => {
    const { limit } = RATE_LIMITS.SIGN_IN_ACCOUNT;
    for (let attempt = 0; attempt < limit + 1; attempt += 1) {
      await checkRateLimit("SIGN_IN_ACCOUNT", "reset@example.com");
    }
    expect(
      (await checkRateLimit("SIGN_IN_ACCOUNT", "reset@example.com")).allowed,
    ).toBe(false);

    await clearRateLimit("SIGN_IN_ACCOUNT", "reset@example.com");

    expect(
      (await checkRateLimit("SIGN_IN_ACCOUNT", "reset@example.com")).allowed,
    ).toBe(true);
  });

  it("reopens the window once it expires", async () => {
    vi.useFakeTimers();
    const { limit, windowSeconds } = RATE_LIMITS.SIGN_IN_ACCOUNT;

    for (let attempt = 0; attempt < limit + 1; attempt += 1) {
      await checkRateLimit("SIGN_IN_ACCOUNT", "window@example.com");
    }
    expect(
      (await checkRateLimit("SIGN_IN_ACCOUNT", "window@example.com")).allowed,
    ).toBe(false);

    vi.advanceTimersByTime(windowSeconds * 1000 + 1000);

    expect(
      (await checkRateLimit("SIGN_IN_ACCOUNT", "window@example.com")).allowed,
    ).toBe(true);
    vi.useRealTimers();
  });

  it("reports a reset time in the future while blocked", async () => {
    const result = await checkRateLimit("PASSWORD_RESET_IP", "198.51.100.4");
    expect(result.resetAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("rate limit policy", () => {
  it("limits accounts more tightly than addresses on sign-in", () => {
    // One address may legitimately serve a whole shop; one account being
    // attacked from many addresses is the case the account budget catches.
    expect(RATE_LIMITS.SIGN_IN_ACCOUNT.limit).toBeLessThan(
      RATE_LIMITS.SIGN_IN_IP.limit,
    );
  });

  it("gives every rule a positive limit and window", () => {
    for (const [name, rule] of Object.entries(RATE_LIMITS)) {
      expect(rule.limit, name).toBeGreaterThan(0);
      expect(rule.windowSeconds, name).toBeGreaterThan(0);
    }
  });

  it("keeps registration and reset budgets small enough to matter", () => {
    expect(RATE_LIMITS.REGISTER_IP.limit).toBeLessThanOrEqual(10);
    expect(RATE_LIMITS.PASSWORD_RESET_ACCOUNT.limit).toBeLessThanOrEqual(5);
  });
});
