import { NextResponse } from "next/server";

/**
 * Liveness.
 *
 * Answers one question: is this process running and able to serve a request.
 * It deliberately does not touch the database — a liveness probe that fails
 * when Postgres is briefly unavailable tells the orchestrator to restart a
 * process that is working perfectly, which turns a database blip into a
 * rolling outage of the application as well.
 *
 * Readiness, which is where the database belongs, is `/api/ready`.
 *
 * The response says nothing about versions, hostnames, or what is installed.
 * A health endpoint is reachable by anybody who can reach the service, and
 * "ok" is the entire useful content of the answer.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(): NextResponse {
  return NextResponse.json(
    { status: "ok" },
    { headers: { "cache-control": "no-store" } },
  );
}
