import { NextResponse } from "next/server";
import { recordAuditLog } from "@/server/audit/audit-log";
import { getCompanyContext } from "@/server/auth/context";
import { logger } from "@/lib/observability/logger";
import { unclassifiedTableNames } from "@/server/company/data-export";
import {
  archiveFilename,
  exportArchiveStream,
} from "@/server/company/export-archive";
import { checkRateLimit } from "@/server/security/rate-limit";

/**
 * A business's own data, as a file it can keep.
 *
 * A GET returning bytes, like the report export beside it and for the same
 * reasons: the browser gets a filename it trusts, and the archive streams
 * rather than being assembled into a blob first.
 *
 * Three gates before a single row is read. **The session decides the company**
 * — there is no company in the URL and no parameter that takes one, so another
 * tenant's books cannot be asked for. **`data.export` is checked separately**
 * from everything else, because taking the whole ledger out of the building is
 * a different act from reading it at a desk. And it is **rate limited**,
 * because it is the most expensive thing this application can be asked to do.
 *
 * Then it is written to the activity log before the download starts. A
 * complete copy of the books leaving is the single event an owner would most
 * want to be able to find afterwards, and that log is append-only.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const context = await getCompanyContext();
  if (!context) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  if (!context.permissions.has("data.export")) {
    return NextResponse.json(
      {
        error:
          "You do not have access to export this business's data. An owner can grant it.",
      },
      { status: 403 },
    );
  }

  const limit = await checkRateLimit("DATA_EXPORT_USER", context.user.id);
  if (!limit.allowed) {
    return NextResponse.json(
      {
        error:
          "That is more exports than an hour needs. The data will be the same shortly — try again then.",
      },
      {
        status: 429,
        headers: { "retry-after": String(limit.retryAfterSeconds) },
      },
    );
  }

  // A company-scoped table nobody has classified would produce an archive that
  // is silently missing something. Refusing is the honest answer: a partial
  // copy of somebody's books that presents itself as complete is worse than no
  // copy at all, because they will find out during a migration.
  const unclassified = unclassifiedTableNames();
  if (unclassified.length > 0) {
    logger.error("Data export refused: unclassified tables", {
      module: "Export",
      tables: unclassified,
    });
    return NextResponse.json(
      {
        error:
          "This installation holds data the export cannot classify, so it will not claim to be complete. Whoever runs it can see which tables in the server log.",
      },
      { status: 500 },
    );
  }

  const generatedAt = new Date();

  await recordAuditLog({
    action: "company.data_exported",
    module: "Settings",
    companyId: context.company.id,
    userId: context.user.id,
    actorEmail: context.user.email,
    entityType: "Company",
    entityId: context.company.id,
    metadata: { generatedAt: generatedAt.toISOString() },
  });

  logger.info("Data export started", {
    module: "Export",
    companyId: context.company.id,
  });

  const stream = exportArchiveStream({
    companyId: context.company.id,
    businessName: context.company.name,
    generatedAt,
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${archiveFilename(context.company.name, generatedAt)}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
