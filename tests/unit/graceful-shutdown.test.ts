import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * SIGTERM drains before it exits.
 *
 * The README states this twice and the replica overlay tunes three numbers
 * around it: an instance stops reporting ready, keeps serving for
 * `SHUTDOWN_DRAIN_MS` so the balancer notices the 503 and stops routing, then
 * closes its database connections and exits. The order is the whole point —
 * a rolling deploy that removes an instance the balancer still believes in
 * severs whatever was in flight, which for this product is a posted sale whose
 * response never arrives and a shopkeeper who does not know whether to enter
 * it again.
 *
 * None of it happened. Against a real build the process was gone twelve
 * milliseconds after the signal, on a fifteen-second window, with exit code
 * 143 — Next's, not this application's. And once the window was honoured the
 * probe still answered `200 ready` for every second of it, because the handler
 * and the route had each been given their own copy of the flag.
 *
 * Neither fault is visible to a test that imports the modules and calls them.
 * `beginDraining()` sets a flag and `isDraining()` reads it; the unit tests
 * that check exactly that were green throughout. What was wrong lives between
 * a process and a signal, so this starts the artefact that ships, sends it a
 * real SIGTERM, and watches.
 *
 * It skips where there is no build, and the first case below is why that skip
 * is safe.
 */

const SERVER = ".next/standalone/server.js";
const PORT = 3311;
const DRAIN_MS = 4000;

/** Says a build is expected, so a missing one fails instead of skipping. */
const EXPECTED = process.env.EXPECT_SHUTDOWN_SERVER === "1";
const BUILT = existsSync(SERVER);

describe("every way this server is started", () => {
  /**
   * A tripwire, and the only part of this file that needs no build.
   *
   * Next registers its own SIGTERM handler before it loads the application,
   * and that handler closes the socket and calls `process.exit(143)`. It skips
   * doing so when `NEXT_MANUAL_SIG_HANDLE` is set, which is its documented way
   * of saying the process owns its own termination. Without the variable the
   * drain below cannot happen, and nothing in the application can set it —
   * Next reads it before any of this code exists.
   *
   * So it has to be set by whatever starts the server, and the failure mode if
   * somebody adds a fourth way to start one is silent: the deploy still works,
   * requests are still served, and only a rolling restart drops them.
   */
  const startPaths: Array<{ what: string; file: string; find: string }> = [
    { what: "the container image", file: "Dockerfile", find: "server.js" },
    { what: "npm start", file: "package.json", find: '"start"' },
    {
      what: "npm run start:standalone",
      file: "package.json",
      find: '"start:standalone"',
    },
  ];

  for (const { what, file } of startPaths) {
    it(`sets NEXT_MANUAL_SIG_HANDLE — ${what}`, () => {
      const text = readFileSync(file, "utf8");
      expect(text).toContain("NEXT_MANUAL_SIG_HANDLE");
    });
  }

  it("sets it on every line that starts a server, not just one of them", () => {
    // The check above passes as long as the string is in the file somewhere,
    // which a second start script would satisfy without being covered.
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    const starters = Object.entries(pkg.scripts).filter(
      ([name, body]) =>
        name.startsWith("start") &&
        (body.includes("next start") || body.includes("standalone/server.js")),
    );

    expect(starters.length).toBeGreaterThan(0);
    for (const [name, body] of starters) {
      expect(
        body,
        `${name} starts a server without the signal handoff`,
      ).toContain("NEXT_MANUAL_SIG_HANDLE");
    }
  });
});

describe("a running server told to shut down", () => {
  it("was there to be started, wherever a build is expected", () => {
    // The one case that never skips, and the reason the rest may. A skip reads
    // as a pass in a CI report, so the job that builds says so and this fails
    // there rather than going quiet.
    if (EXPECTED) {
      expect(
        BUILT,
        `${SERVER} is missing — this job builds, so the drain went untested`,
      ).toBe(true);
    } else {
      expect(true).toBe(true);
    }
  });

  /** What a real signal did to a real process. Collected once. */
  const seen = {
    portWasFree: false,
    readyBefore: 0,
    duringSignal: [] as Array<{ atMs: number; status: number; body: string }>,
    exitCode: null as number | null,
    exitSignal: null as string | null,
    elapsedMs: -1,
    diedWhileBooting: false,
    log: "",
  };

  let child: ChildProcess | undefined;

  beforeAll(async () => {
    if (!BUILT) return;

    // Whatever answers this port has to be the process this test started.
    //
    // Learned the hard way: a server left over from an earlier run held the
    // port, the child could not bind, and every probe below was answered by
    // the stale process — which reported itself ready and undraining exactly
    // as a broken drain would. The test failed for the right reason by luck.
    // A port that is already occupied is not a drain that went wrong, and the
    // two should never again be reported as the same thing.
    try {
      await fetch(`http://127.0.0.1:${PORT}/api/ready`, {
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      seen.portWasFree = true;
    }
    if (!seen.portWasFree) return;

    child = spawn("node", [SERVER], {
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(PORT),
        HOSTNAME: "127.0.0.1",
        SHUTDOWN_DRAIN_MS: String(DRAIN_MS),
        APP_URL: `http://localhost:${PORT}`,
        // The variable under test in the block above. Set here too, because
        // this spawn is not `npm start` — it is the artefact the container
        // runs, started the way the container starts it.
        NEXT_MANUAL_SIG_HANDLE: "1",
        // A production boot is subject to the production hardening in env.ts,
        // and this test inherits a test environment. `.env.test` carries an
        // AUTH_SECRET beginning "test-only", which is precisely what that
        // hardening refuses — so inheriting it left the server refusing to
        // boot and this file reporting a drain that never had a process to
        // drain. Overridden rather than passed through, the same way the
        // browser job supplies its own for the same reason.
        AUTH_SECRET: "shutdown-test-secret-at-least-32-characters-long",
        RATE_LIMIT_ALLOW_IN_MEMORY: "true",
        EMAIL_ALLOW_CONSOLE: "true",
        // The drain announces itself at info, and `.env.test` runs at error so
        // the suite is quiet. Inheriting that would hide the very lines this
        // file reads to tell whose handler ran.
        LOG_LEVEL: "info",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (b: Buffer) => (seen.log += b.toString()));
    child.stderr?.on("data", (b: Buffer) => (seen.log += b.toString()));

    const exited = new Promise<void>((resolve) => {
      child?.on("exit", (code, signal) => {
        seen.exitCode = code;
        seen.exitSignal = signal;
        resolve();
      });
    });

    // Up for long enough to be worth draining.
    for (let i = 0; i < 120; i += 1) {
      if (child.exitCode !== null || child.signalCode !== null) {
        // It fell over on the way up. Waiting the rest of the minute out would
        // report a timeout when the log already says what happened.
        seen.diedWhileBooting = true;
        return;
      }
      try {
        const response = await fetch(`http://127.0.0.1:${PORT}/api/ready`);
        if (response.ok) {
          seen.readyBefore = response.status;
          break;
        }
      } catch {
        // Not listening yet.
      }
      await sleep(500);
    }

    const sentAt = Date.now();
    child.kill("SIGTERM");

    // Ask the question the load balancer asks, at the moment it asks it.
    const probing = (async () => {
      for (let i = 0; i < 12; i += 1) {
        await sleep(300);
        const atMs = Date.now() - sentAt;
        try {
          const response = await fetch(`http://127.0.0.1:${PORT}/api/ready`);
          seen.duringSignal.push({
            atMs,
            status: response.status,
            body: await response.text(),
          });
        } catch (error) {
          seen.duringSignal.push({
            atMs,
            status: 0,
            body: String((error as { cause?: { code?: string } })?.cause?.code),
          });
        }
      }
    })();

    await Promise.race([exited, sleep(DRAIN_MS + 30_000)]);
    seen.elapsedMs = Date.now() - sentAt;
    await Promise.race([probing, sleep(1000)]);
  }, 180_000);

  afterAll(() => {
    if (child && child.exitCode === null) child.kill("SIGKILL");
  });

  it.skipIf(!BUILT)("had the port to itself", () => {
    expect(
      seen.portWasFree,
      `something was already answering on ${PORT} — nothing below this tests the server this file started`,
    ).toBe(true);
  });

  it.skipIf(!BUILT)("was serving before the signal", () => {
    expect(
      seen.diedWhileBooting,
      `the server exited on the way up:\n${seen.log}`,
    ).toBe(false);
    expect(seen.readyBefore, `never became ready:\n${seen.log}`).toBe(200);
  });

  it.skipIf(!BUILT)("stops reporting ready as soon as it is told to go", () => {
    // The probe the balancer calls, half a second after the signal. Answering
    // `ready` here is what makes a drain ceremonial, and answering nothing at
    // all — a refused connection — is the failure it exists to prevent.
    const first = seen.duringSignal[0];
    expect(first, "no probe was taken").toBeDefined();
    expect(
      first?.status,
      `at ${first?.atMs}ms the probe answered ${first?.status} ${first?.body}`,
    ).toBe(503);
    expect(first?.body).toContain("draining");
  });

  it.skipIf(!BUILT)("keeps answering that for the whole window", () => {
    // Not just the first probe. The balancer's health check interval is what
    // the window is tuned against, and one 503 followed by silence would leave
    // it routing to a socket that has gone.
    const withinWindow = seen.duringSignal.filter(
      (p) => p.atMs < DRAIN_MS - 500,
    );
    expect(withinWindow.length).toBeGreaterThan(2);
    for (const probe of withinWindow) {
      expect(probe.status, `at ${probe.atMs}ms it answered ${probe.body}`).toBe(
        503,
      );
    }
  });

  it.skipIf(!BUILT)("stays up until the window has passed", () => {
    // The measured failure was twelve milliseconds. A margin rather than the
    // exact number, because the timer is a timer.
    expect(seen.elapsedMs).toBeGreaterThanOrEqual(DRAIN_MS - 250);
  });

  it.skipIf(!BUILT)("then leaves on its own terms", () => {
    // Code 0 from this application's handler, having disconnected the
    // database. Code 143 is Next's own handler exiting on the signal, which is
    // what used to happen and means nothing below it ran.
    expect(
      seen.exitCode,
      `exit code ${seen.exitCode}, signal ${seen.exitSignal}`,
    ).toBe(0);
    expect(seen.log).toContain("Draining before shutdown");
    expect(seen.log).toContain("Shutting down");
  });

  it.skipIf(!BUILT)("does not take forever about it", () => {
    // The other way to fail: manual signal handling with no handler installed
    // leaves the container hanging until the orchestrator's grace period runs
    // out and SIGKILLs it, which severs exactly what the drain protects.
    expect(seen.elapsedMs).toBeLessThan(DRAIN_MS + 15_000);
  });
});
