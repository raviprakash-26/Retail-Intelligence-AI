import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

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
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
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
