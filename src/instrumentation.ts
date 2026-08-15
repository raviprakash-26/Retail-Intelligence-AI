/**
 * Runs once when the server process starts, before any request is handled.
 *
 * Validating the environment here means a misconfigured deployment fails
 * immediately and loudly, rather than serving traffic until the first request
 * touches the missing variable.
 *
 * It is also where the shutdown handlers go. They have to be installed before
 * the first request rather than lazily, because the signal they wait for can
 * arrive at any moment — including during a deploy that replaces an instance
 * which has not yet served anything.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertEnv } = await import("@/lib/env");
    assertEnv();

    const { installShutdownHandlers } = await import("@/server/lifecycle");
    installShutdownHandlers();
  }
}
