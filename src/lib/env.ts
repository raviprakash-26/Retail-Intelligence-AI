import "server-only";
import { z } from "zod";

/**
 * Validated environment configuration.
 *
 * The application refuses to boot with an invalid configuration. Failing at
 * startup with a precise message is far safer for a financial system than
 * discovering a missing key when a user tries to post an invoice.
 *
 * Server-only values live here; anything the browser may see lives in
 * `public-env.ts`. Importing this module from a client component is a build
 * error, which is what the `server-only` import above is for — the comment
 * used to claim that guard existed before the import did.
 */

const nonEmpty = (label: string) =>
  z.string().trim().min(1, `${label} must not be empty`);

const booleanish = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((value) =>
    typeof value === "boolean" ? value : value === "true" || value === "1",
  );

const serverSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    APP_URL: z.url().default("http://localhost:3000"),

    DATABASE_URL: nonEmpty("DATABASE_URL").refine(
      (value) =>
        value.startsWith("postgres://") || value.startsWith("postgresql://"),
      "DATABASE_URL must be a PostgreSQL connection string",
    ),
    DIRECT_DATABASE_URL: z.string().trim().optional(),

    AUTH_SECRET: z
      .string()
      .min(32, "AUTH_SECRET must be at least 32 characters of entropy"),
    SESSION_MAX_AGE_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .max(60 * 60 * 24 * 30)
      .default(60 * 60 * 12),
    PASSWORD_HASH_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),

    STORAGE_DRIVER: z.enum(["local", "s3", "r2", "supabase"]).default("local"),
    STORAGE_LOCAL_DIR: z.string().default("./.storage"),
    STORAGE_BUCKET: z.string().optional(),
    STORAGE_REGION: z.string().optional(),
    STORAGE_ENDPOINT: z.string().optional(),
    STORAGE_ACCESS_KEY_ID: z.string().optional(),
    STORAGE_SECRET_ACCESS_KEY: z.string().optional(),
    STORAGE_PUBLIC_BASE_URL: z.string().optional(),

    AI_DRIVER: z.enum(["disabled", "anthropic", "openai"]).default("disabled"),
    AI_API_KEY: z.string().optional(),
    AI_MODEL: z.string().default("claude-sonnet-5"),
    // Covers the model's thinking *and* its answer, not the answer alone. The
    // previous 2048 was sized as if it were the answer alone, which on the
    // current models silently cut replies off mid-sentence.
    AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(8192),

    PAYMENTS_DRIVER: z
      .enum(["disabled", "razorpay", "stripe"])
      .default("disabled"),
    RAZORPAY_KEY_ID: z.string().optional(),
    RAZORPAY_KEY_SECRET: z.string().optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),

    EMAIL_DRIVER: z.enum(["console", "smtp", "resend"]).default("console"),
    EMAIL_FROM: z
      .string()
      .default("Retail Intelligence AI <no-reply@example.com>"),
    SMTP_URL: z.string().optional(),
    RESEND_API_KEY: z.string().optional(),

    RATE_LIMIT_DRIVER: z.enum(["memory", "redis"]).default("memory"),
    REDIS_URL: z.string().optional(),
    /**
     * Acknowledges that in-memory rate limiting is per-instance. Required to
     * boot a production build without Redis, so a multi-replica deployment
     * cannot end up with an ineffective limiter by omission.
     */
    RATE_LIMIT_ALLOW_IN_MEMORY: booleanish.default(false),

    /**
     * Says out loud that this deployment sends no email.
     *
     * The console driver is a development affordance: it prints the message —
     * the whole message, including the link in a password reset — and reports
     * it as delivered. It is also the default, so a production deployment that
     * simply did not set `EMAIL_DRIVER` printed reset tokens into its own logs
     * and told the person at the keyboard that a link was on its way.
     *
     * The same shape as `RATE_LIMIT_ALLOW_IN_MEMORY`, for the same reason: the
     * setting is defensible while somebody is trying the product out, and
     * indefensible by omission.
     */
    EMAIL_ALLOW_CONSOLE: booleanish.default(false),

    /**
     * Names this replica in logs and in the metrics scrape.
     *
     * Optional because the container's hostname is a good default and every
     * orchestrator sets one. Worth overriding where the hostname is a random
     * hash and something like "app-mumbai-2" would mean more to whoever is
     * reading at three in the morning.
     */
    INSTANCE_ID: z.string().optional(),
    /**
     * How long to keep answering requests after a shutdown signal, before the
     * process exits.
     *
     * It has to exceed the load balancer's health-check interval, or the
     * balancer never notices the instance is draining and keeps routing to it
     * until the moment it disappears — which is the failure the drain exists to
     * prevent. Ten seconds suits a two-second check; the orchestrator's own
     * grace period must be longer again.
     */
    SHUTDOWN_DRAIN_MS: z.coerce.number().int().min(0).default(10_000),

    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    /**
     * Bearer token the metrics endpoint requires. Absent means the endpoint
     * does not exist — off by default, because process counts and database
     * reachability are reconnaissance in a way that "ok" is not, and an
     * operator opting in is a decision somebody made.
     */
    METRICS_TOKEN: z
      .string()
      .min(16, "METRICS_TOKEN needs at least 16 characters to be worth having")
      .optional(),
    SEED_DEMO_DATA: booleanish.default(false),
  })
  // Each pluggable driver states its own required configuration, so a
  // half-configured integration is caught at boot rather than at first use.
  .superRefine((value, ctx) => {
    /** Flags a variable that a chosen driver cannot work without. */
    const needs = (field: string, present: unknown, why: string) => {
      if (!present) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is required ${why}`,
        });
      }
    };

    if (value.STORAGE_DRIVER !== "local") {
      const why = `when STORAGE_DRIVER is "${value.STORAGE_DRIVER}"`;
      needs("STORAGE_BUCKET", value.STORAGE_BUCKET, why);
      needs("STORAGE_ACCESS_KEY_ID", value.STORAGE_ACCESS_KEY_ID, why);
      needs("STORAGE_SECRET_ACCESS_KEY", value.STORAGE_SECRET_ACCESS_KEY, why);
    }

    if (value.AI_DRIVER !== "disabled") {
      needs(
        "AI_API_KEY",
        value.AI_API_KEY,
        `when AI_DRIVER is "${value.AI_DRIVER}"`,
      );
    }

    if (value.PAYMENTS_DRIVER === "razorpay") {
      const why = "when PAYMENTS_DRIVER is razorpay";
      needs("RAZORPAY_KEY_ID", value.RAZORPAY_KEY_ID, why);
      needs("RAZORPAY_KEY_SECRET", value.RAZORPAY_KEY_SECRET, why);
      // The webhook is not an extra: it is the only thing that moves a plan.
      //
      // The key id and secret are enough to open a checkout, so an
      // installation without this one started cleanly, reported payments as
      // available, and took real money — and then the webhook that confirms it
      // answered 404, because the handler will not verify what it has no secret
      // to verify against. Nothing said so at boot. The customer paid and the
      // plan stayed where it was, which is the worst way for a payment
      // integration to be half-configured.
      if (!value.RAZORPAY_WEBHOOK_SECRET) {
        ctx.addIssue({
          code: "custom",
          path: ["RAZORPAY_WEBHOOK_SECRET"],
          message:
            "RAZORPAY_WEBHOOK_SECRET is required when PAYMENTS_DRIVER is razorpay. " +
            "A plan only moves when the provider's webhook confirms the payment, " +
            "so without it a customer is charged and nothing happens. Take it from " +
            "the webhook you registered in the Razorpay dashboard.",
        });
      }
    }

    if (value.PAYMENTS_DRIVER === "stripe") {
      needs(
        "STRIPE_SECRET_KEY",
        value.STRIPE_SECRET_KEY,
        "when PAYMENTS_DRIVER is stripe",
      );
    }

    if (value.EMAIL_DRIVER === "smtp") {
      needs("SMTP_URL", value.SMTP_URL, "when EMAIL_DRIVER is smtp");
    }

    if (value.EMAIL_DRIVER === "resend") {
      needs(
        "RESEND_API_KEY",
        value.RESEND_API_KEY,
        "when EMAIL_DRIVER is resend",
      );
    }

    if (value.RATE_LIMIT_DRIVER === "redis") {
      needs("REDIS_URL", value.REDIS_URL, "when RATE_LIMIT_DRIVER is redis");
    }

    // These are *runtime* hardening checks. `next build` runs with
    // NODE_ENV=production and collects page data, which imports server
    // modules — but a build serves no traffic, so demanding a real
    // AUTH_SECRET and a Redis URL there would force production secrets into
    // every CI build environment for no security benefit.
    const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";

    if (value.NODE_ENV === "production" && !isBuildPhase) {
      if (
        value.AUTH_SECRET.includes("replace-me") ||
        value.AUTH_SECRET.startsWith("test-only")
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["AUTH_SECRET"],
          message:
            "AUTH_SECRET is still the placeholder value. Generate one with: openssl rand -base64 48",
        });
      }
      if (
        value.APP_URL.startsWith("http://") &&
        !value.APP_URL.includes("localhost")
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["APP_URL"],
          message:
            "APP_URL must use https in production (session cookies are Secure-only)",
        });
      }
      if (value.EMAIL_DRIVER === "console" && !value.EMAIL_ALLOW_CONSOLE) {
        ctx.addIssue({
          code: "custom",
          path: ["EMAIL_DRIVER"],
          message:
            "The console email driver prints messages to the log instead of sending them, " +
            "including the link in a password reset — so nobody can recover an account and " +
            "the token sits in your logs. Configure a real driver, or set " +
            "EMAIL_ALLOW_CONSOLE=true to acknowledge that this deployment sends no email.",
        });
      }
      if (
        value.RATE_LIMIT_DRIVER === "memory" &&
        !value.RATE_LIMIT_ALLOW_IN_MEMORY
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["RATE_LIMIT_DRIVER"],
          message:
            "In-memory rate limiting is per-instance and does not hold across replicas. " +
            "Set RATE_LIMIT_DRIVER=redis with a REDIS_URL, or set " +
            "RATE_LIMIT_ALLOW_IN_MEMORY=true to acknowledge a single-instance deployment.",
        });
      }
    }
  });

export type ServerEnv = z.infer<typeof serverSchema>;

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  • ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}

function loadServerEnv(): ServerEnv {
  const parsed = serverSchema.safeParse(process.env);

  if (!parsed.success) {
    throw new Error(
      `Invalid environment configuration.\n\n${formatIssues(parsed.error)}\n\n` +
        `See .env.example for the full list of supported variables.`,
    );
  }

  return parsed.data;
}

let cached: ServerEnv | undefined;

/**
 * Server-side environment. Lazily parsed and memoised so that importing this
 * module in a context that never reads `env` (for example, a shared type-only
 * import) does not blow up.
 */
export const env: ServerEnv = new Proxy({} as ServerEnv, {
  get(_target, prop: string) {
    cached ??= loadServerEnv();
    return cached[prop as keyof ServerEnv];
  },
  has(_target, prop: string) {
    cached ??= loadServerEnv();
    return prop in cached;
  },
  ownKeys() {
    cached ??= loadServerEnv();
    return Reflect.ownKeys(cached);
  },
  getOwnPropertyDescriptor(_target, prop: string) {
    cached ??= loadServerEnv();
    return Reflect.getOwnPropertyDescriptor(cached, prop);
  },
});

/** Eagerly validate. Called from instrumentation so failures surface at boot. */
export function assertEnv(): void {
  cached ??= loadServerEnv();
}

/** Test-only escape hatch to re-read `process.env` after mutating it. */
export function resetEnvCacheForTests(): void {
  cached = undefined;
}
