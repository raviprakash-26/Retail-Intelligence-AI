import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isDraining } from "@/lib/observability/instance";

/**
 * Readiness.
 *
 * Answers a different question from liveness: should this instance be sent
 * traffic right now. It needs the database, because an instance that cannot
 * reach Postgres can serve nothing worth serving — every page in the product
 * reads the ledger.
 *
 * On failure it returns 503 and the word "unavailable", and nothing else. The
 * reason goes to the log, where an operator can see it and a stranger cannot:
 * a connection error quoted back over HTTP names the host, the port, the
 * database and often the user.
 *
 * It also answers 503 while the instance is draining, which is the whole point
 * of having a readiness probe separate from a liveness one. A replica being
 * replaced is still alive and still finishing the requests it holds — it simply
 * must not be given new ones. Liveness keeps saying ok, so nothing kills it
 * mid-drain.
 *
 * What it deliberately does not say is *which* replica answered. That would be
 * genuinely useful to an operator and is exactly the reconnaissance this
 * endpoint refuses to hand out — it is unauthenticated and reachable by anyone.
 * Instance identity goes to the logs and to the token-gated metrics scrape,
 * both of which have a reader who has already proved something.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  if (isDraining()) {
    return NextResponse.json(
      { status: "draining" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    // The cheapest round trip that proves a real connection rather than a
    // pooled handle that has not been used since the network went away.
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json(
      { status: "ready" },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    console.error("Readiness check failed", error);
    return NextResponse.json(
      { status: "unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
