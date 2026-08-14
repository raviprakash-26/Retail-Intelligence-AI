import { describe, expect, it } from "vitest";
import { isSameOrigin, rateLimitKey } from "@/server/security/request-context";

/**
 * `.env.test` sets APP_URL to http://localhost:3000, which is the configured
 * origin these cases compare against.
 */
const CONFIGURED_HOST = "localhost:3000";

describe("isSameOrigin — CSRF protection", () => {
  it("accepts an origin matching the host the request arrived on", () => {
    // The deployment-agnostic case: served on a port or domain that differs
    // from APP_URL, which must still work rather than blocking every action.
    expect(isSameOrigin("http://localhost:3111", "localhost:3111")).toBe(true);
    expect(
      isSameOrigin("https://preview-7.example.app", "preview-7.example.app"),
    ).toBe(true);
  });

  it("accepts an origin matching the configured APP_URL", () => {
    expect(isSameOrigin(`http://${CONFIGURED_HOST}`, null)).toBe(true);
    // A proxy that rewrites Host but not Origin must not lock users out.
    expect(
      isSameOrigin(`http://${CONFIGURED_HOST}`, "internal-service:8080"),
    ).toBe(true);
  });

  it("rejects an attacker's origin", () => {
    expect(isSameOrigin("https://evil.example", "localhost:3111")).toBe(false);
    expect(isSameOrigin("http://evil.example", CONFIGURED_HOST)).toBe(false);
  });

  it("rejects a lookalike host", () => {
    expect(
      isSameOrigin("http://localhost:3000.evil.example", CONFIGURED_HOST),
    ).toBe(false);
    expect(isSameOrigin("http://notlocalhost:3000", CONFIGURED_HOST)).toBe(
      false,
    );
  });

  it("treats a different port as a different origin", () => {
    expect(isSameOrigin("http://localhost:9999", CONFIGURED_HOST)).toBe(false);
  });

  it("rejects a malformed origin", () => {
    expect(isSameOrigin("not a url", CONFIGURED_HOST)).toBe(false);
    expect(isSameOrigin("://missing-scheme", CONFIGURED_HOST)).toBe(false);
  });

  it("rejects the literal null origin", () => {
    // Sandboxed iframes and some redirects send Origin: null. It is not ours.
    expect(isSameOrigin("null", CONFIGURED_HOST)).toBe(false);
  });

  it("allows a request with no Origin header", () => {
    // Same-origin form posts and non-browser clients omit it; a cross-site
    // POST from a browser never does.
    expect(isSameOrigin(null, CONFIGURED_HOST)).toBe(true);
    expect(isSameOrigin(null, null)).toBe(true);
  });
});

describe("rateLimitKey", () => {
  it("uses the address when known", () => {
    expect(rateLimitKey("203.0.113.7")).toBe("203.0.113.7");
  });

  it("falls back to a constant so a missing IP cannot bypass the limit", () => {
    expect(rateLimitKey(null)).toBe("unknown-ip");
  });
});
