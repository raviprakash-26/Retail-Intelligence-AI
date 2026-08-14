import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertEnv, resetEnvCacheForTests } from "@/lib/env";

/**
 * The application refuses to boot on a configuration it cannot trust.
 *
 * That refusal is a claim the README makes, and until now nothing checked it.
 * It matters most for the two cases that are easy to ship by accident: a
 * placeholder signing secret carried over from the example file, and a
 * production deployment addressed over plain http.
 *
 * These tests mutate `process.env` and put it back. The env module memoises,
 * so each one resets the cache before reading — a stale parse would make a
 * later test pass for the wrong reason.
 */

const REQUIRED = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://user:pass@localhost:5432/riai",
  AUTH_SECRET: "x".repeat(48),
  APP_URL: "https://books.example.com",
  // Acknowledged rather than assumed — see the test below for why the
  // validator insists on one or the other.
  RATE_LIMIT_ALLOW_IN_MEMORY: "true",
} as const;

let original: NodeJS.ProcessEnv;

beforeEach(() => {
  original = { ...process.env };
  resetEnvCacheForTests();
});

afterEach(() => {
  process.env = original;
  resetEnvCacheForTests();
});

/** Replaces the environment wholesale, so a stray real value cannot rescue it. */
function withEnv(overrides: Record<string, string | undefined>): void {
  process.env = { ...REQUIRED, ...overrides } as NodeJS.ProcessEnv;
  resetEnvCacheForTests();
}

describe("a configuration the application will accept", () => {
  it("boots on a complete one", () => {
    withEnv({});
    expect(() => assertEnv()).not.toThrow();
  });

  it("boots in development with the conveniences left on", () => {
    withEnv({ NODE_ENV: "development", APP_URL: "http://localhost:3000" });
    expect(() => assertEnv()).not.toThrow();
  });
});

describe("a configuration it refuses", () => {
  it("will not start without a database", () => {
    withEnv({ DATABASE_URL: undefined });
    expect(() => assertEnv()).toThrow(/DATABASE_URL/);
  });

  it("will not accept something that is not a PostgreSQL connection string", () => {
    withEnv({ DATABASE_URL: "mysql://user:pass@localhost/riai" });
    expect(() => assertEnv()).toThrow(/PostgreSQL/);
  });

  it("will not start on the placeholder signing secret in production", () => {
    // The single likeliest way to deploy something insecure: copy
    // .env.example, fill in the database, forget this line.
    withEnv({ AUTH_SECRET: "replace-me-with-a-real-secret-value-here-okay" });
    expect(() => assertEnv()).toThrow(/AUTH_SECRET/);
  });

  it("will not serve a production deployment over plain http", () => {
    withEnv({ APP_URL: "http://books.example.com" });
    expect(() => assertEnv()).toThrow(/APP_URL/);
  });

  it("allows plain http on localhost, which is not a deployment", () => {
    withEnv({ APP_URL: "http://localhost:3000" });
    expect(() => assertEnv()).not.toThrow();
  });

  it("will not accept a signing secret too short to be one", () => {
    withEnv({ AUTH_SECRET: "short" });
    expect(() => assertEnv()).toThrow(/AUTH_SECRET/);
  });

  it("will not silently rate limit in memory across replicas", () => {
    // Two instances with in-memory counters give an attacker twice the
    // budget, quietly. The deployment must either use Redis or say out loud
    // that it runs one instance.
    withEnv({ RATE_LIMIT_ALLOW_IN_MEMORY: undefined });
    expect(() => assertEnv()).toThrow(/RATE_LIMIT_DRIVER|REDIS_URL/);
  });

  it("accepts Redis instead of that acknowledgement", () => {
    withEnv({
      RATE_LIMIT_ALLOW_IN_MEMORY: undefined,
      RATE_LIMIT_DRIVER: "redis",
      REDIS_URL: "redis://localhost:6379",
    });
    expect(() => assertEnv()).not.toThrow();
  });
});

describe("a driver without what it needs", () => {
  it("refuses an AI driver with no key", () => {
    withEnv({ AI_DRIVER: "anthropic", AI_API_KEY: undefined });
    expect(() => assertEnv()).toThrow(/AI_API_KEY/);
  });

  it("refuses Razorpay with no credentials", () => {
    withEnv({ PAYMENTS_DRIVER: "razorpay" });
    expect(() => assertEnv()).toThrow(/RAZORPAY_KEY_ID|RAZORPAY_KEY_SECRET/);
  });

  it("refuses SMTP with no server", () => {
    withEnv({ EMAIL_DRIVER: "smtp", SMTP_URL: undefined });
    expect(() => assertEnv()).toThrow(/SMTP_URL/);
  });

  it("refuses object storage with no bucket", () => {
    withEnv({ STORAGE_DRIVER: "s3" });
    expect(() => assertEnv()).toThrow(/STORAGE_BUCKET/);
  });

  it("says which variable and why, not merely that something is wrong", () => {
    withEnv({ EMAIL_DRIVER: "smtp", SMTP_URL: undefined });
    // A boot failure at three in the morning should name the line to fix.
    expect(() => assertEnv()).toThrow(/SMTP_URL is required when EMAIL_DRIVER/);
  });
});
