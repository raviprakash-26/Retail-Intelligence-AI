import "server-only";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/observability/logger";
import { beginDraining, INSTANCE_ID } from "@/lib/observability/instance";

/**
 * Shutting down without dropping work.
 *
 * An orchestrator replacing a replica sends SIGTERM and then, some seconds
 * later, SIGKILL. The default behaviour in between is to exit immediately —
 * which severs whatever requests were in flight. For this product that means a
 * posted sale whose HTTP response never arrives, and a shopkeeper who does not
 * know whether to enter it again.
 *
 * So the sequence is: stop saying "ready", give the load balancer time to
 * notice and stop routing, then let the process end. The drain window has to be
 * longer than the balancer's health-check interval or it achieves nothing —
 * that is the number worth tuning, and it is configurable for exactly that
 * reason.
 *
 * This is deliberately not a request-tracking implementation. Counting
 * in-flight requests inside a Next.js server means wrapping its handler, which
 * is a much larger and more fragile thing to own; waiting out a fixed window
 * covers the same failure with none of that surface, and the window is stated
 * rather than guessed.
 */

let installed = false;

export function installShutdownHandlers(): void {
  // `register()` can run more than once in development as modules reload, and
  // a second set of handlers would drain twice.
  if (installed) return;
  installed = true;

  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    const wait = env.SHUTDOWN_DRAIN_MS;
    beginDraining();
    logger.info("Draining before shutdown", {
      module: "Lifecycle",
      instance: INSTANCE_ID,
      signal,
      drainMs: wait,
    });

    setTimeout(() => {
      void (async () => {
        try {
          // Returns the connections to the pool cleanly. Without it Postgres
          // holds them until its own timeout, and a deploy that replaces
          // several replicas at once can exhaust max_connections.
          await prisma.$disconnect();
        } catch (error) {
          logger.warn("Could not close the database connection cleanly", {
            module: "Lifecycle",
            instance: INSTANCE_ID,
            error,
          });
        }
        logger.info("Shutting down", {
          module: "Lifecycle",
          instance: INSTANCE_ID,
        });
        process.exit(0);
      })();
    }, wait).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
