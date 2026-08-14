import { afterEach, describe, expect, it } from "vitest";
import { redactValue, REDACTED_KEYS } from "@/lib/redaction";
import {
  buildRecord,
  describeError,
  shouldLog,
} from "@/lib/observability/logger";
import {
  incrementCounter,
  recordActionFailure,
  renderPrometheus,
  resetMetrics,
  setGauge,
  snapshot,
} from "@/lib/observability/metrics";

/**
 * Logging and metrics.
 *
 * Both exist to be read by a machine, which is why they are tested by their
 * output rather than by "did it not throw". A log line an aggregator cannot
 * parse and a scrape a collector rejects both fail silently in production.
 */

afterEach(() => resetMetrics());

describe("redaction", () => {
  it("strips values whose key names a secret", () => {
    const redacted = redactValue({
      email: "owner@example.com",
      password: "MountainRiver42!",
      sessionToken: "abc",
      nested: { apiKey: "sk-live-1" },
    }) as Record<string, unknown>;

    expect(redacted.email).toBe("owner@example.com");
    expect(redacted.password).toBe("[redacted]");
    expect(redacted.sessionToken).toBe("[redacted]");
    expect((redacted.nested as Record<string, unknown>).apiKey).toBe(
      "[redacted]",
    );
  });

  it("matches on the key rather than sniffing the value", () => {
    // A rule that guessed from the shape of a value would fail open on the one
    // secret shaped unusually, which is the only case that matters.
    expect(REDACTED_KEYS.test("PASSWORD")).toBe(true);
    expect(REDACTED_KEYS.test("passwordHash")).toBe(true);
    expect(REDACTED_KEYS.test("passwordHint")).toBe(false);
  });

  it("bounds what it keeps, so nothing can flood the destination", () => {
    expect(redactValue("x".repeat(3000))).toHaveLength(2001);
    expect(redactValue(Array.from({ length: 100 }, () => 1))).toHaveLength(50);
  });

  it("stops descending rather than following a cycle forever", () => {
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic.self = cyclic;
    expect(() => redactValue(cyclic)).not.toThrow();
    expect(JSON.stringify(redactValue(cyclic))).toContain("[truncated]");
  });
});

describe("a log record", () => {
  it("carries the three fields an aggregator indexes on", () => {
    const record = buildRecord(
      "info",
      "Payroll posted",
      {},
      new Date("2026-08-14T09:00:00Z"),
    );
    expect(record.level).toBe("info");
    expect(record.message).toBe("Payroll posted");
    expect(record.time).toBe("2026-08-14T09:00:00.000Z");
  });

  it("keeps context as fields rather than folding it into the message", () => {
    const record = buildRecord("warn", "Slow query", {
      module: "Sales",
      ms: 1200,
    });
    expect(record.module).toBe("Sales");
    expect(record.ms).toBe(1200);
  });

  it("will not let context overwrite those three fields", () => {
    const record = buildRecord("error", "Real message", {
      level: "debug",
      message: "Injected",
      time: "not a time",
    });
    expect(record.level).toBe("error");
    expect(record.message).toBe("Real message");
    expect(record.time).not.toBe("not a time");
  });

  it("redacts context, because a log aggregator is durable storage too", () => {
    const record = buildRecord("info", "Sign-in", {
      email: "owner@example.com",
      password: "MountainRiver42!",
    });
    expect(record.password).toBe("[redacted]");
    expect(JSON.stringify(record)).not.toContain("MountainRiver42!");
  });

  it("unwraps an Error, which JSON.stringify otherwise flattens to nothing", () => {
    // `JSON.stringify(new Error("x"))` is `{}` — which is how exceptions
    // quietly become empty objects in logs.
    expect(JSON.stringify(new Error("boom"))).toBe("{}");

    const described = describeError(new Error("boom")) as Record<
      string,
      unknown
    >;
    expect(described.name).toBe("Error");
    expect(described.message).toBe("boom");
    expect(Array.isArray(described.stack)).toBe(true);
  });

  it("serialises to a single line, since one record is one line", () => {
    const line = JSON.stringify(
      buildRecord("error", "Failed", { error: new Error("boom") }),
    );
    expect(line.includes("\n")).toBe(false);
    expect(JSON.parse(line).error.message).toBe("boom");
  });
});

describe("log levels", () => {
  it("keeps what is at or above the threshold and drops the rest", () => {
    expect(shouldLog("error", "info")).toBe(true);
    expect(shouldLog("info", "info")).toBe(true);
    expect(shouldLog("debug", "info")).toBe(false);
    expect(shouldLog("warn", "error")).toBe(false);
  });
});

describe("metrics", () => {
  it("accumulates a counter per label set", () => {
    recordActionFailure("Sales", "UNEXPECTED");
    recordActionFailure("Sales", "UNEXPECTED");
    recordActionFailure("Payroll", "UNEXPECTED");

    const counter = snapshot().find(
      (entry) => entry.name === "riai_action_failures_total",
    );
    const sales = counter?.samples.find(
      (sample) => sample.labels.module === "Sales",
    );
    const payroll = counter?.samples.find(
      (sample) => sample.labels.module === "Payroll",
    );

    expect(sales?.value).toBe(2);
    expect(payroll?.value).toBe(1);
  });

  it("replaces a gauge rather than adding to it", () => {
    setGauge("riai_test_gauge", "help", 5);
    setGauge("riai_test_gauge", "help", 9);
    const gauge = snapshot().find((entry) => entry.name === "riai_test_gauge");
    expect(gauge?.samples).toHaveLength(1);
    expect(gauge?.samples[0]?.value).toBe(9);
  });

  it("renders exposition a scraper will accept", () => {
    incrementCounter("riai_test_total", "A test counter.", { kind: "sale" }, 3);
    const text = renderPrometheus();

    expect(text).toContain("# HELP riai_test_total A test counter.");
    expect(text).toContain("# TYPE riai_test_total counter");
    expect(text).toContain('riai_test_total{kind="sale"} 3');
    // The format requires a trailing newline.
    expect(text.endsWith("\n")).toBe(true);
  });

  it("escapes a label value that would otherwise break the format", () => {
    incrementCounter("riai_test_total", "A test counter.", {
      kind: 'we"ird\nvalue',
    });
    const line = renderPrometheus()
      .split("\n")
      .find((entry) => entry.startsWith("riai_test_total{"));

    expect(line).toContain('\\"');
    expect(line).toContain("\\n");
    // One sample is still one line.
    expect(renderPrometheus().split("\n").filter(Boolean)).toHaveLength(3);
  });

  it("renders nothing at all when nothing has been recorded", () => {
    expect(renderPrometheus()).toBe("");
  });

  it("records no tenant identity, only the module and the code", () => {
    // Running the platform does not require reading anybody's books, and a
    // scrape endpoint is the last place to make an exception.
    recordActionFailure("Sales", "UNEXPECTED");
    const text = renderPrometheus();
    expect(text).toContain('module="Sales"');
    expect(text).not.toMatch(/company|tenant|email/i);
  });
});
