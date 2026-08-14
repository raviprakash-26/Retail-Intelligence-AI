import { expect, test } from "@playwright/test";

/**
 * The endpoints an orchestrator watches.
 *
 * Two of them, answering different questions, and the difference is the point:
 * liveness says the process is running, readiness says it should be sent
 * traffic. Conflating them means a database blip restarts every container in
 * the deployment, turning a recoverable outage into a longer one.
 *
 * Both are reachable by anybody who can reach the service, so both are checked
 * for saying nothing beyond the answer.
 */

test.describe("health probes", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("liveness answers without a session", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("readiness answers when the database is reachable", async ({
    request,
  }) => {
    const response = await request.get("/api/ready");
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ status: "ready" });
  });

  test("neither says anything about the deployment", async ({ request }) => {
    // No version, no hostname, no library list, no connection string. "ok" is
    // the entire useful content of a health answer, and everything beyond it
    // is reconnaissance handed to whoever asks.
    for (const path of ["/api/health", "/api/ready"]) {
      const body = await (await request.get(path)).text();
      expect(body.length).toBeLessThan(64);
      expect(body).not.toMatch(
        /postgres|version|host|node|prisma|\d+\.\d+\.\d+/i,
      );
    }
  });

  test("neither is cached, or a probe would answer for a dead process", async ({
    request,
  }) => {
    for (const path of ["/api/health", "/api/ready"]) {
      const response = await request.get(path);
      expect(response.headers()["cache-control"]).toContain("no-store");
    }
  });
});

test.describe("metrics", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("does not exist until an operator switches it on", async ({
    request,
  }) => {
    // METRICS_TOKEN is unset here, which is the default. A 404 rather than a
    // 401 is deliberate: a 401 would confirm there is something behind the
    // door worth guessing a token for.
    const response = await request.get("/api/metrics");
    expect(response.status()).toBe(404);
    expect(await response.text()).not.toMatch(/riai_|# TYPE/);
  });

  test("a wrong token is answered exactly like an unconfigured endpoint", async ({
    request,
  }) => {
    const response = await request.get("/api/metrics", {
      headers: { authorization: "Bearer not-the-token-at-all" },
    });
    expect(response.status()).toBe(404);
    expect(await response.text()).not.toMatch(/riai_/);
  });
});
