import { describe, expect, it } from "vitest";
import {
  fail,
  ok,
  safeRedirectPath,
  zodFieldErrors,
} from "@/server/auth/action-result";

describe("safeRedirectPath — open redirect protection", () => {
  it("accepts a same-site absolute path", () => {
    expect(safeRedirectPath("/app/sales")).toBe("/app/sales");
    expect(safeRedirectPath("/app?tab=summary")).toBe("/app?tab=summary");
  });

  it("rejects an absolute URL to another origin", () => {
    expect(safeRedirectPath("https://evil.example/steal")).toBe("/app");
    expect(safeRedirectPath("http://evil.example")).toBe("/app");
  });

  it("rejects a protocol-relative URL", () => {
    // Browsers resolve "//evil.example" against the current scheme, making it
    // absolute. This is the classic open-redirect bypass.
    expect(safeRedirectPath("//evil.example/path")).toBe("/app");
    expect(safeRedirectPath("//evil.example")).toBe("/app");
  });

  it("rejects a backslash-obfuscated URL", () => {
    // Some browsers normalise backslashes to forward slashes in URLs.
    expect(safeRedirectPath("/\\evil.example")).toBe("/app");
    expect(safeRedirectPath("\\\\evil.example")).toBe("/app");
  });

  it("rejects other schemes", () => {
    expect(safeRedirectPath("javascript:alert(1)")).toBe("/app");
    expect(safeRedirectPath("data:text/html,<script>")).toBe("/app");
  });

  it("rejects a path that does not start with a slash", () => {
    expect(safeRedirectPath("app/sales")).toBe("/app");
    expect(safeRedirectPath("evil.example")).toBe("/app");
  });

  it("falls back for empty input", () => {
    expect(safeRedirectPath(null)).toBe("/app");
    expect(safeRedirectPath(undefined)).toBe("/app");
    expect(safeRedirectPath("")).toBe("/app");
  });

  it("honours a custom fallback", () => {
    expect(safeRedirectPath(null, "/onboarding")).toBe("/onboarding");
    expect(safeRedirectPath("https://evil.example", "/onboarding")).toBe(
      "/onboarding",
    );
  });

  it("drops any fragment", () => {
    expect(safeRedirectPath("/app#section")).toBe("/app");
  });
});

describe("zodFieldErrors", () => {
  it("dots nested paths so they match form field names", () => {
    const errors = zodFieldErrors([
      { path: ["account", "email"], message: "Invalid email." },
      { path: ["business", "gstin"], message: "Invalid GSTIN." },
    ]);

    expect(errors).toEqual({
      "account.email": "Invalid email.",
      "business.gstin": "Invalid GSTIN.",
    });
  });

  it("keeps only the first message per field", () => {
    const errors = zodFieldErrors([
      { path: ["password"], message: "Too short." },
      { path: ["password"], message: "Needs a number." },
    ]);

    expect(errors.password).toBe("Too short.");
  });

  it("ignores issues with no path", () => {
    const errors = zodFieldErrors([{ path: [], message: "Form-level." }]);
    expect(errors).toEqual({});
  });
});

describe("result helpers", () => {
  it("narrows on the ok discriminant", () => {
    const success = ok({ value: 42 });
    expect(success.ok).toBe(true);
    if (success.ok) expect(success.data.value).toBe(42);

    const failure = fail("Nope", { code: "X", retryAfterSeconds: 30 });
    expect(failure.ok).toBe(false);
    if (!failure.ok) {
      expect(failure.message).toBe("Nope");
      expect(failure.code).toBe("X");
      expect(failure.retryAfterSeconds).toBe(30);
    }
  });
});
