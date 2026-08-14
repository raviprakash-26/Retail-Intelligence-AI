/**
 * The handful of settings the browser is allowed to know.
 *
 * Separate from `env.ts` for one reason, found by a test that reads the built
 * client bundle: a client component importing `publicEnv` from the same module
 * as the server schema drags that whole schema into the browser. No secret
 * *value* was leaking — the schema is a list of names and validation rules —
 * but shipping a map of every credential the deployment expects is not
 * something to do by accident, and it left the arrangement one careless default
 * away from shipping the values too.
 *
 * Next.js inlines `process.env.NEXT_PUBLIC_*` at build time, so these must be
 * written out by their full literal name rather than looked up dynamically.
 */
export const publicEnv = {
  appName: process.env.NEXT_PUBLIC_APP_NAME ?? "Retail Intelligence AI",
  appShortName: process.env.NEXT_PUBLIC_APP_SHORT_NAME ?? "RIAI",
  defaultCurrency: process.env.NEXT_PUBLIC_DEFAULT_CURRENCY ?? "INR",
  defaultLocale: process.env.NEXT_PUBLIC_DEFAULT_LOCALE ?? "en-IN",
} as const;
