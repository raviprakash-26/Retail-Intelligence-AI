import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMetrics } from "@/lib/observability/metrics";

/**
 * The metrics endpoint, when somebody is allowed to read it.
 *
 * The browser suite already proves it refuses — unconfigured, and with a wrong
 * token. Nothing proved there was anything behind the door. That is testing
 * that a room is locked without ever checking it has a floor: a gauge that
 * threw, an empty body or a wrong content type would have left every test
 * green.
 *
 * `env` parses the environment once, at import. So the token has to be in place
 * before the route module is loaded, which is why each case resets the module
 * registry and imports inside the test rather than at the top of the file.
 */

const TOKEN = "a-metrics-token-long-enough-to-pass";

/**
 * The route and the registry it reads, from the same module graph.
 *
 * `resetModules` gives the route a fresh copy of everything it imports,
 * including the metrics registry — so a counter recorded through this file's
 * own import lands in a different instance and never appears in the response.
 * In production they are one module; the test has to reproduce that rather
 * than assert against two.
 */
async function loadRoute() {
  vi.resetModules();
  const metrics = await import("@/lib/observability/metrics");
  const route = await import("@/app/api/metrics/route");
  return { GET: route.GET, metrics };
}

function request(headers: Record<string, string> = {}) {
  return new Request("http://localhost:3000/api/metrics", { headers });
}

beforeEach(() => {
  resetMetrics();
  process.env.METRICS_TOKEN = TOKEN;
});

afterEach(() => {
  delete process.env.METRICS_TOKEN;
  resetMetrics();
  vi.resetModules();
});

describe("with a correct token", () => {
  it("answers with Prometheus text rather than an empty body", async () => {
    const { GET } = await loadRoute();
    const response = await GET(
      request({ authorization: `Bearer ${TOKEN}` }) as never,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = await response.text();
    expect(body).toContain("riai_up");
    expect(body).toContain("# TYPE riai_up gauge");
    // The database was reachable, so the probe says so rather than guessing.
    expect(body).toMatch(/riai_database_up 1/);
    expect(body).toContain("riai_process_uptime_seconds");
    expect(body).toContain("riai_process_resident_memory_bytes");
  }, 60_000);

  it("says on its first line that the counts are per-process", async () => {
    // A counter that silently means "since the last deploy" is worse than no
    // counter, and the scrape is where somebody would misread it.
    const { GET } = await loadRoute();
    const response = await GET(
      request({ authorization: `Bearer ${TOKEN}` }) as never,
    );
    const body = await response.text();

    expect(body.split("\n")[0]).toMatch(/per-process/i);
    expect(body.split("\n")[0]).toMatch(/reset/i);
  }, 60_000);

  it("includes counters the application recorded", async () => {
    const { GET, metrics } = await loadRoute();
    metrics.recordActionFailure("Sales", "UNEXPECTED");
    metrics.recordActionFailure("Sales", "UNEXPECTED");

    const response = await GET(
      request({ authorization: `Bearer ${TOKEN}` }) as never,
    );
    const body = await response.text();

    expect(body).toMatch(
      /riai_action_failures_total\{code="UNEXPECTED",module="Sales"\} 2/,
    );
  }, 60_000);

  it("says which replica answered, so several can be scraped apart", async () => {
    // Behind more than one instance a scrape reaches whichever the balancer
    // chose. Without an instance label two replicas each reporting forty
    // failures is either eighty failures or one replica scraped twice, and
    // nothing in the output distinguishes them.
    const { GET } = await loadRoute();
    const response = await GET(
      request({ authorization: `Bearer ${TOKEN}` }) as never,
    );
    const body = await response.text();

    expect(body).toMatch(/riai_instance_info\{instance="[^"]+"\} 1/);
    expect(body).toMatch(
      /riai_instance_started_at_seconds\{instance="[^"]+"\}/,
    );
    // Not draining, because this process is not shutting down.
    expect(body).toMatch(/riai_instance_draining\{instance="[^"]+"\} 0/);

    // And the header says not to sum blindly across replicas.
    expect(body).toMatch(/group by the instance label/i);
  }, 60_000);

  it("carries nothing about a tenant's business", async () => {
    // Running the platform does not require reading anybody's books, and a
    // scrape endpoint is the last place to make an exception.
    const { GET, metrics } = await loadRoute();
    metrics.recordActionFailure("Payroll", "UNEXPECTED");

    const response = await GET(
      request({ authorization: `Bearer ${TOKEN}` }) as never,
    );
    const body = await response.text();

    expect(body).not.toMatch(/company|tenant|@|gstin|invoice/i);
  }, 60_000);
});

describe("with anything else", () => {
  it("refuses a wrong token with the same 404 an unconfigured route gives", async () => {
    const { GET } = await loadRoute();
    const response = await GET(
      request({ authorization: "Bearer not-the-token-at-all" }) as never,
    );

    expect(response.status).toBe(404);
    expect(await response.text()).not.toMatch(/riai_/);
  }, 60_000);

  it("refuses a token of a different length without throwing", async () => {
    // timingSafeEqual throws on buffers of unequal length, so the guard in
    // front of it is load-bearing rather than an optimisation.
    const { GET } = await loadRoute();
    const response = await GET(request({ authorization: "Bearer x" }) as never);

    expect(response.status).toBe(404);
  }, 60_000);

  it("refuses a missing header", async () => {
    const { GET } = await loadRoute();
    const response = await GET(request() as never);
    expect(response.status).toBe(404);
  }, 60_000);

  it("does not exist at all when no token is configured", async () => {
    delete process.env.METRICS_TOKEN;
    const { GET } = await loadRoute();
    const response = await GET(
      request({ authorization: `Bearer ${TOKEN}` }) as never,
    );

    expect(response.status).toBe(404);
    expect(await response.text()).not.toMatch(/riai_/);
  }, 60_000);
});
