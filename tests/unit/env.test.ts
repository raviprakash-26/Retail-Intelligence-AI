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
  // Acknowledged for the same reason, and tested on its own below.
  EMAIL_ALLOW_CONSOLE: "true",
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

describe("a deployment that would send no email", () => {
  /**
   * The console driver prints the message and calls it delivered.
   *
   * That is what a development machine wants and the opposite of what a live
   * one does. It is also the default, so a production deployment that simply
   * never set `EMAIL_DRIVER` printed password-reset links into its own logs
   * and told the person at the keyboard that a link was on its way — nobody
   * recovers an account, and the token is sitting in the log of whoever can
   * read them.
   *
   * Guarded the way in-memory rate limiting is: allowed, but only out loud.
   */
  it("refuses the console driver in production", () => {
    withEnv({ EMAIL_ALLOW_CONSOLE: undefined });
    expect(() => assertEnv()).toThrow(/EMAIL_DRIVER|console email driver/);
  });

  it("says what goes wrong rather than naming the setting", () => {
    // "Set EMAIL_DRIVER" tells somebody what to type. It does not tell them
    // that until they do, nobody can reset a password.
    withEnv({ EMAIL_ALLOW_CONSOLE: undefined });
    expect(() => assertEnv()).toThrow(/password reset/);
  });

  it("accepts it once the deployment says so out loud", () => {
    withEnv({ EMAIL_ALLOW_CONSOLE: "true" });
    expect(() => assertEnv()).not.toThrow();
  });

  it("leaves a real driver alone", () => {
    withEnv({
      EMAIL_DRIVER: "smtp",
      SMTP_URL: "smtp://user:pass@mail.example.com:587",
      EMAIL_ALLOW_CONSOLE: undefined,
    });
    expect(() => assertEnv()).not.toThrow();
  });
});

describe("a setting left blank", () => {
  /**
   * Blank means "not set" throughout this file — `SMTP_URL=`, `AI_API_KEY=`
   * and the payment keys all ship blank in `.env.example` and mean absent.
   * The metrics token used to read a blank as a token of length zero and
   * refuse to boot over it, which is why its example line was the only one
   * that had to be commented out rather than left empty, and why a compose
   * deployment could not forward it at all.
   */
  it("turns the metrics endpoint off rather than refusing to start", () => {
    withEnv({ METRICS_TOKEN: "" });
    expect(() => assertEnv()).not.toThrow();
  });

  it("still refuses a token too short to be worth having", () => {
    // Blank is a decision. Four characters is a mistake, and the distinction
    // is the whole reason there is a minimum.
    withEnv({ METRICS_TOKEN: "abcd" });
    expect(() => assertEnv()).toThrow(/METRICS_TOKEN/);
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

  /**
   * The webhook secret is not an extra.
   *
   * A key id and secret are enough to open a checkout, so an installation
   * without the webhook secret started cleanly, reported payments as
   * available, and took real money — and then the webhook that confirms the
   * payment answered 404, because the handler will not verify what it has no
   * secret to verify against. The client says as much in its own comment: the
   * plan moves when the provider tells the server so, and nothing else moves
   * it. So the customer was charged and their plan stayed where it was.
   */
  it("refuses Razorpay with keys but no webhook secret", () => {
    withEnv({
      PAYMENTS_DRIVER: "razorpay",
      RAZORPAY_KEY_ID: "rzp_live_example",
      RAZORPAY_KEY_SECRET: "x".repeat(24),
      RAZORPAY_WEBHOOK_SECRET: undefined,
    });
    expect(() => assertEnv()).toThrow(/RAZORPAY_WEBHOOK_SECRET/);
  });

  it("says why, because a missing webhook is not obvious from the symptom", () => {
    // The symptom is a customer being charged and nothing happening, which
    // looks like a provider fault rather than a missing variable.
    withEnv({
      PAYMENTS_DRIVER: "razorpay",
      RAZORPAY_KEY_ID: "rzp_live_example",
      RAZORPAY_KEY_SECRET: "x".repeat(24),
      RAZORPAY_WEBHOOK_SECRET: undefined,
    });
    expect(() => assertEnv()).toThrow(/charged and nothing happens/);
  });

  it("accepts Razorpay configured all the way through", () => {
    withEnv({
      PAYMENTS_DRIVER: "razorpay",
      RAZORPAY_KEY_ID: "rzp_live_example",
      RAZORPAY_KEY_SECRET: "x".repeat(24),
      RAZORPAY_WEBHOOK_SECRET: "y".repeat(24),
    });
    expect(() => assertEnv()).not.toThrow();
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
