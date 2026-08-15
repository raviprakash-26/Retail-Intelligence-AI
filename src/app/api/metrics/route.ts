import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import {
  INSTANCE_ID,
  STARTED_AT,
  isDraining,
} from "@/lib/observability/instance";
import { env } from "@/lib/env";
import { renderPrometheus, setGauge } from "@/lib/observability/metrics";

/**
 * Metrics, for whoever runs the service.
 *
 * A third endpoint beside liveness and readiness, answering a third question:
 * not "is it alive" or "should it get traffic" but "what has it been doing".
 *
 * Unlike those two it is **off by default**. Health says `ok` and nothing else
 * precisely so that anybody who can reach the service learns nothing from it;
 * process counts and database reachability do not meet that bar, so the
 * endpoint exists only once an operator sets METRICS_TOKEN and 404s otherwise
 * — not 401, because a 401 confirms there is something there to guess at.
 *
 * The figures are per-process and reset on restart. That is stated here, in the
 * README and in the payload, because a counter that silently means "since the
 * last deploy" is worse than no counter.
 *
 * Nothing about a tenant's business appears. No turnover, no invoice counts, no
 * company names — running the platform does not require reading anybody's
 * books, and a scrape endpoint is the last place to make an exception.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const startedAt = Date.now();

/** Compares in constant time, so a wrong token cannot be found byte by byte. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const expected = env.METRICS_TOKEN;
  if (!expected) {
    return new NextResponse("Not found", { status: 404 });
  }

  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!presented || !tokenMatches(presented, expected)) {
    // Same answer as an unconfigured endpoint: a caller without the token
    // cannot tell whether metrics are switched on.
    return new NextResponse("Not found", { status: 404 });
  }

  const memory = process.memoryUsage();
  setGauge("riai_up", "Always 1. Present so a scrape can be alerted on.", 1);
  setGauge(
    "riai_process_uptime_seconds",
    "Seconds since this process started.",
    Math.round((Date.now() - startedAt) / 1000),
  );
  setGauge(
    "riai_process_resident_memory_bytes",
    "Resident set size of this process.",
    memory.rss,
  );

  let databaseUp = 1;
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    databaseUp = 0;
  }
  setGauge(
    "riai_database_up",
    "1 when the database answered a trivial query, 0 when it did not.",
    databaseUp,
  );

  // Which replica answered, and whether it is on its way out.
  //
  // Behind several instances a scrape reaches whichever one the balancer chose,
  // and without this the counts are unattributable — two replicas each showing
  // "40 failures" is either eighty failures or one replica scraped twice, and
  // there is no way to tell them apart. `riai_instance_info` carries the name
  // as a label so Prometheus can group by it.
  setGauge(
    "riai_instance_info",
    "Always 1. The labels identify which replica answered this scrape.",
    1,
    { instance: INSTANCE_ID },
  );
  setGauge(
    "riai_instance_started_at_seconds",
    "Unix time this process started. A change means this replica restarted.",
    STARTED_AT,
    { instance: INSTANCE_ID },
  );
  setGauge(
    "riai_instance_draining",
    "1 while this replica is shutting down and refusing new traffic.",
    isDraining() ? 1 : 0,
    { instance: INSTANCE_ID },
  );

  const body =
    `# Counts are per-process and reset when the process restarts.\n` +
    `# Behind several replicas each answers for itself — scrape every instance, ` +
    `and group by the instance label rather than summing blindly.\n` +
    renderPrometheus();

  return new NextResponse(body, {
    headers: {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
