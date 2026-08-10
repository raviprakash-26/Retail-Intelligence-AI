import { describe, expect, it } from "vitest";
import { redactMetadata } from "@/server/audit/audit-log";

/**
 * Audit metadata is assembled by callers, and a caller spreading a whole form
 * object into it is a mistake waiting to happen. These tests pin the last line
 * of defence: whatever arrives, credentials do not get written to a table that
 * is deliberately impossible to delete from.
 */
describe("audit metadata redaction", () => {
  it("redacts credential-bearing keys", () => {
    const result = redactMetadata({
      email: "owner@example.com",
      password: "hunter2",
      confirmPassword: "hunter2",
      passwordHash: "$2b$12$abc",
      token: "raw-token",
      tokenHash: "deadbeef",
      secret: "s3cret",
      apiKey: "sk-live-123",
    });

    expect(result).toEqual({
      email: "owner@example.com",
      password: "[redacted]",
      confirmPassword: "[redacted]",
      passwordHash: "[redacted]",
      token: "[redacted]",
      tokenHash: "[redacted]",
      secret: "[redacted]",
      apiKey: "[redacted]",
    });
  });

  it("matches keys case-insensitively", () => {
    const result = redactMetadata({ PASSWORD: "x", Token: "y", ApiKey: "z" });
    expect(result).toEqual({
      PASSWORD: "[redacted]",
      Token: "[redacted]",
      ApiKey: "[redacted]",
    });
  });

  it("redacts inside nested objects", () => {
    const result = redactMetadata({
      account: { email: "a@b.com", password: "hunter2" },
      business: { name: "Ravi Retail Mart" },
    });

    expect(result).toEqual({
      account: { email: "a@b.com", password: "[redacted]" },
      business: { name: "Ravi Retail Mart" },
    });
  });

  it("redacts inside arrays", () => {
    const result = redactMetadata([{ password: "a" }, { password: "b" }]);
    expect(result).toEqual([
      { password: "[redacted]" },
      { password: "[redacted]" },
    ]);
  });

  it("does not redact keys that merely contain a sensitive word", () => {
    // "passwordChangedAt" is metadata worth keeping; only exact matches go.
    const result = redactMetadata({
      passwordChangedAt: "2026-08-09",
      resetTokenSentAt: "2026-08-09",
    });
    expect(result).toEqual({
      passwordChangedAt: "2026-08-09",
      resetTokenSentAt: "2026-08-09",
    });
  });

  it("preserves primitives", () => {
    expect(redactMetadata({ count: 3, flag: true, name: "x" })).toEqual({
      count: 3,
      flag: true,
      name: "x",
    });
  });

  it("truncates very long strings", () => {
    const result = redactMetadata({ note: "a".repeat(5000) }) as Record<
      string,
      string
    >;
    expect(result.note?.length).toBeLessThanOrEqual(2001);
    expect(result.note?.endsWith("…")).toBe(true);
  });

  it("caps array length so one call cannot bloat the table", () => {
    const result = redactMetadata(Array.from({ length: 500 }, (_, i) => i));
    expect(Array.isArray(result) && result.length).toBe(50);
  });

  it("stops recursing on deeply nested input", () => {
    let nested: Record<string, unknown> = { value: "deep" };
    for (let depth = 0; depth < 20; depth += 1) {
      nested = { nested };
    }
    // Must terminate rather than blow the stack.
    expect(() => redactMetadata(nested)).not.toThrow();
  });
});
