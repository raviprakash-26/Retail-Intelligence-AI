import { afterEach, describe, expect, it } from "vitest";
import {
  INSTANCE_ID,
  STARTED_AT,
  beginDraining,
  isDraining,
  resetLifecycleForTests,
} from "@/lib/observability/instance";

/**
 * Instance identity and the drain flag.
 *
 * Small surface, and load-bearing behind more than one replica: the flag is
 * what a readiness probe reads to say "stop sending me traffic", and the
 * identity is what makes two replicas' logs and metrics tellable apart.
 */

afterEach(() => {
  resetLifecycleForTests();
});

describe("instance identity", () => {
  it("has a name that is never empty", () => {
    // Falling back to the hostname means this works in a container without
    // anybody configuring anything, which is when it matters most.
    expect(INSTANCE_ID).toBeTruthy();
    expect(INSTANCE_ID.length).toBeGreaterThan(0);
  });

  it("records when the process started, in whole seconds", () => {
    // Prometheus gauges are numbers, and a millisecond timestamp read as
    // seconds would put the start date in the year 57000.
    expect(Number.isInteger(STARTED_AT)).toBe(true);
    const now = Math.floor(Date.now() / 1000);
    expect(STARTED_AT).toBeLessThanOrEqual(now);
    expect(STARTED_AT).toBeGreaterThan(now - 3600);
  });
});

describe("draining", () => {
  it("starts out serving traffic", () => {
    expect(isDraining()).toBe(false);
  });

  it("stops serving once told to", () => {
    beginDraining();
    expect(isDraining()).toBe(true);
  });

  it("does not come back into service", () => {
    // One way only. An instance that reported ready again after a shutdown
    // signal would be handed traffic it is about to drop.
    beginDraining();
    beginDraining();
    expect(isDraining()).toBe(true);
  });
});
