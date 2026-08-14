import { createClient, type RedisClientType } from "redis";
import { afterAll, describe, expect, it } from "vitest";
import { redisStoreForTests } from "@/server/security/rate-limit";

/**
 * The Redis-backed rate limiter, against a real Redis.
 *
 * Mocking the client here would test that the code calls the functions it
 * calls. The properties worth proving are all properties of Redis itself: that
 * the counter is shared, that it expires, and that incrementing and setting the
 * lifetime happen together. None survives a mock.
 *
 * The suite skips with a reason where no server is reachable, because that is a
 * fact about the machine rather than a defect.
 */

const REDIS_URL = process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:6379";

const HIT_SCRIPT = `
  local current = redis.call('INCR', KEYS[1])
  if current == 1 then
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
  end
  return {current, redis.call('PTTL', KEYS[1])}
`;

/**
 * Probed at module scope, deliberately.
 *
 * `describe.skipIf` is evaluated when the file is collected, which happens
 * before any `beforeAll` runs — so a flag set in a hook is still false when the
 * decision is made, and every case skips while the run reports green. That is
 * the worst outcome available: a suite that looks like coverage and is not.
 * Top-level await settles it before the describe is registered.
 */
const probe: RedisClientType | undefined = await (async () => {
  try {
    // Fail fast rather than retrying: node-redis reconnects indefinitely by
    // default, so without this the probe never settles and the whole file
    // hangs instead of skipping.
    const client: RedisClientType = createClient({
      url: REDIS_URL,
      socket: { connectTimeout: 1_000, reconnectStrategy: false },
    });
    client.on("error", () => {});
    await client.connect();
    await client.ping();
    return client;
  } catch {
    console.warn(`Redis rate-limit tests skipped: no server at ${REDIS_URL}`);
    return undefined;
  }
})();

/**
 * In CI a missing Redis is a failure, not a skip.
 *
 * A skipped suite reports green, which makes "the tests ran" indistinguishable
 * from "the service never came up" — and the whole point of adding a Redis
 * service to the workflow was to exercise a real server. Encoding that here
 * means the build says so, rather than somebody remembering to read a log.
 *
 * Locally it still skips: not having Redis installed is a fact about the
 * machine rather than a defect.
 */
if (probe === undefined && process.env.CI === "true") {
  throw new Error(
    `Redis is required in CI and none answered at ${REDIS_URL}. ` +
      "The workflow declares a redis service; if it did not start, fix that " +
      "rather than letting these tests skip into a green build.",
  );
}

const available = probe !== undefined;

afterAll(async () => {
  if (probe?.isOpen) await probe.quit();
}, 30_000);

/** A fresh key per test, so one case cannot inherit another's count. */
const freshKey = () =>
  `ratelimit:test:${Date.now()}:${Math.random().toString(36).slice(2)}`;

async function hit(
  client: RedisClientType,
  key: string,
  windowMs: number,
): Promise<{ count: number; ttl: number }> {
  const [count, ttl] = (await client.eval(HIT_SCRIPT, {
    keys: [key],
    arguments: [String(windowMs)],
  })) as [number, number];
  return { count, ttl };
}

describe.skipIf(!available)("the shared counter", () => {
  it("counts up and reports a lifetime from the first hit", async () => {
    const client = probe!;
    const key = freshKey();

    const first = await hit(client, key, 60_000);
    expect(first.count).toBe(1);
    // The window is set on the first hit, not left without one.
    expect(first.ttl).toBeGreaterThan(0);
    expect(first.ttl).toBeLessThanOrEqual(60_000);

    const second = await hit(client, key, 60_000);
    expect(second.count).toBe(2);
  }, 30_000);

  it("does not extend the window on later hits", async () => {
    // A fixed window, not a sliding one. Re-arming the expiry on every attempt
    // would let a steady trickle hold somebody out indefinitely.
    const client = probe!;
    const key = freshKey();

    const first = await hit(client, key, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const second = await hit(client, key, 5_000);

    expect(second.ttl).toBeLessThan(first.ttl);
  }, 30_000);

  it("is shared between connections, which is the whole point", async () => {
    // Two clients stand in for two application instances. On the in-memory
    // driver each would keep its own count, and the configured limit would
    // quietly become twice what somebody set.
    const client = probe!;
    const other: RedisClientType = createClient({ url: REDIS_URL });
    other.on("error", () => {});
    await other.connect();

    const key = freshKey();
    try {
      await hit(client, key, 60_000);
      const fromOther = await hit(other, key, 60_000);
      expect(fromOther.count).toBe(2);
    } finally {
      await other.quit();
    }
  }, 30_000);

  it("expires, so a limit lifts on its own", async () => {
    const client = probe!;
    const key = freshKey();

    await hit(client, key, 300);
    expect(await client.exists(key)).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await client.exists(key)).toBe(0);

    // And the next attempt starts a fresh window rather than resuming.
    const after = await hit(client, key, 60_000);
    expect(after.count).toBe(1);
  }, 30_000);

  it("never leaves a counter without a lifetime", async () => {
    // The failure this guards: INCR succeeding and EXPIRE not, which leaves a
    // key that never resets and an identifier locked out permanently. The
    // script makes the pair atomic, so there is no interleaving that produces
    // one without the other.
    const client = probe!;
    const key = freshKey();

    await Promise.all(
      Array.from({ length: 25 }, () => hit(client, key, 60_000)),
    );

    const ttl = await client.pTTL(key);
    // -1 is "exists, no expiry" — the state that must be impossible.
    expect(ttl).toBeGreaterThan(0);
    expect(Number(await client.get(key))).toBe(25);
  }, 30_000);

  it("clears a counter when asked, as a successful sign-in does", async () => {
    const client = probe!;
    const key = freshKey();

    await hit(client, key, 60_000);
    await client.del(key);

    const after = await hit(client, key, 60_000);
    expect(after.count).toBe(1);
  }, 30_000);
});

describe("when Redis cannot be reached", () => {
  it("allows the request rather than hanging, and does so quickly", async () => {
    // The behaviour the README documents, against an address nothing is
    // listening on. It was unreachable when first written: node-redis retries
    // forever, so the fallback never ran and a sign-in would have waited
    // indefinitely — worse than either failing open or failing closed.
    const store = redisStoreForTests("redis://127.0.0.1:6399");

    const started = Date.now();
    const result = await store.hit("test:unreachable", {
      limit: 5,
      windowSeconds: 60,
    });
    const elapsed = Date.now() - started;

    expect(result.allowed).toBe(true);
    // Bounded, and comfortably inside anything a person would wait for.
    expect(elapsed).toBeLessThan(5_000);
  }, 30_000);
});
