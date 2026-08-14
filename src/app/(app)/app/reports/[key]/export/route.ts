import { NextResponse, type NextRequest } from "next/server";
import { csvFilename, toCsv } from "@/lib/reports/csv";
import { recordAuditLog } from "@/server/audit/audit-log";
import { getCompanyContext } from "@/server/auth/context";
import { authorizeReport } from "@/server/reports/access";
import { runReport, ReportError } from "@/server/reports/report-service";

/**
 * A report, as a file.
 *
 * A download rather than a server action, because that is what it is: a GET
 * that reads and returns bytes. Doing it as an action would mean building the
 * CSV in memory in the browser and handing it to a blob, which is more moving
 * parts for a worse result — no streaming, no filename the browser trusts, and
 * a content policy to argue with.
 *
 * It runs the same `runReport` the page ran, behind the same `authorizeReport`
 * the page used. That is the point: the file cannot show figures the screen
 * would have refused, and it cannot disagree with the screen either.
 *
 * `reports.export` is checked separately from `reports.view`. Reading a report
 * at a desk and carrying a copy of the ledger out of the building are different
 * acts, and a business that distinguishes them should be able to.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
): Promise<NextResponse> {
  const context = await getCompanyContext();
  if (!context) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const { key } = await params;
  const access = await authorizeReport({ context, key });

  if (!access.allowed) {
    return NextResponse.json(
      { error: access.message },
      { status: access.reason === "unknown" ? 404 : 403 },
    );
  }
  if (!context.permissions.has("reports.export")) {
    return NextResponse.json(
      { error: "You do not have access to export reports." },
      { status: 403 },
    );
  }

  const search = request.nextUrl.searchParams;
  const number = (name: string) => {
    const raw = search.get(name);
    if (!raw) return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  try {
    const report = await runReport({
      companyId: context.company.id,
      key: access.definition.key,
      period: {
        from: search.get("from") ?? undefined,
        to: search.get("to") ?? undefined,
        year: number("year"),
        month: number("month"),
      },
    });

    // A report is the form in which a tenant's figures actually leave. Who
    // took a copy, of what, and when is worth being able to answer.
    await recordAuditLog({
      action: "report.exported",
      module: "Reports",
      companyId: context.company.id,
      userId: context.user.id,
      actorEmail: context.user.email,
      entityType: "Report",
      entityId: access.definition.key,
      metadata: { report: access.definition.title, period: report.period },
    });

    // The byte-order mark is what makes Excel read the file as UTF-8. Without
    // it ₹ arrives as mojibake on a Windows machine, which is most of them.
    // It is added here rather than in `toCsv` so the serialiser stays a pure
    // function of the report and its tests read the text they expect.
    return new NextResponse(`﻿${toCsv(report)}`, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${csvFilename(access.definition.key)}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof ReportError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("Report export failed", error);
    return NextResponse.json(
      { error: "That report could not be built." },
      { status: 500 },
    );
  }
}
