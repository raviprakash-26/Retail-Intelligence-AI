/**
 * Runs once when the server process starts, before any request is handled.
 *
 * Validating the environment here means a misconfigured deployment fails
 * immediately and loudly, rather than serving traffic until the first request
 * touches the missing variable.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertEnv } = await import("@/lib/env");
    assertEnv();
  }
}
