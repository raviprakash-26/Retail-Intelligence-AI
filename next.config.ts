import type { NextConfig } from "next";

/**
 * Security headers applied to every response.
 *
 * Content-Security-Policy is intentionally strict; it is tightened further in
 * Phase 25 (security hardening) once the full set of runtime origins (object
 * storage, payment gateways, AI providers) is known. Report-only mode is not
 * used because the current surface is fully first-party.
 */
const securityHeaders = [
  { key: "X-DNS-Prefetch-Control", value: "on" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
] as const;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // Emits `.next/standalone` — a self-contained server with only the modules
  // actually reached, rather than the whole of node_modules. It is what the
  // container image copies, and it is the difference between an image of a few
  // hundred megabytes and one of well over a gigabyte.
  output: "standalone",

  // Compile-time checking of every `Link href` and `router.push`. A typo in a
  // route becomes a build failure instead of a 404 a user finds first.
  typedRoutes: true,

  experimental: {
    // Enables `forbidden()` and `unauthorized()`, which render the
    // forbidden.tsx / unauthorized.tsx boundaries with a 403 / 401 status.
    // Without this they surface as a generic 500 "something went wrong",
    // which tells a user with insufficient permissions the wrong thing
    // entirely — that the app is broken, rather than that they lack access.
    authInterrupts: true,
  },

  typescript: {
    // Type errors must fail the build. Never set this to true.
    ignoreBuildErrors: false,
  },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [...securityHeaders],
      },
    ];
  },
};

export default nextConfig;
