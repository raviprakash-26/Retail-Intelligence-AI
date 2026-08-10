import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma, type DbClient } from "@/lib/db";

/**
 * Audit logging.
 *
 * The table is append-only, enforced by database triggers. Nothing here can
 * update or delete a row, and neither can a future caller.
 *
 * Writing an audit entry must never take down the operation it is recording:
 * a failed log is reported to the server console and swallowed, because
 * refusing a customer's sale because the audit insert timed out is the wrong
 * trade. Anything that genuinely must be transactional with its subject passes
 * the transaction client explicitly.
 */

export const AUDIT_ACTION = {
  SIGN_IN: "auth.sign_in",
  SIGN_IN_FAILED: "auth.sign_in_failed",
  SIGN_IN_BLOCKED: "auth.sign_in_blocked",
  SIGN_OUT: "auth.sign_out",
  REGISTER: "auth.register",
  EMAIL_VERIFIED: "auth.email_verified",
  PASSWORD_RESET_REQUESTED: "auth.password_reset_requested",
  PASSWORD_RESET_COMPLETED: "auth.password_reset_completed",
  PASSWORD_CHANGED: "auth.password_changed",
  SESSIONS_REVOKED: "auth.sessions_revoked",
  COMPANY_CREATED: "company.created",
  COMPANY_SWITCHED: "company.switched",
} as const;

export type AuditAction = (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION];

export type AuditEntry = {
  action: AuditAction | string;
  module: string;
  companyId?: string | null;
  userId?: string | null;
  actorEmail?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Prisma.InputJsonValue;
  ipAddress?: string | null;
  userAgent?: string | null;
};

/**
 * Keys whose values must never reach the audit log, matched case-insensitively
 * against the whole key. Metadata is assembled by callers, and a caller
 * spreading a whole form object is a mistake waiting to happen.
 */
const REDACTED_KEYS =
  /^(password|newPassword|confirmPassword|passwordHash|token|tokenHash|secret|apiKey|authorization|cookie|sessionToken)$/i;

/** Recursively strips sensitive values before anything is persisted. */
export function redactMetadata(
  value: unknown,
  depth = 0,
): Prisma.InputJsonValue {
  if (depth > 6) return "[truncated]";
  if (value === null || value === undefined)
    return null as unknown as Prisma.InputJsonValue;

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactMetadata(item, depth + 1));
  }

  if (typeof value === "object") {
    const result: Record<string, Prisma.InputJsonValue> = {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      result[key] = REDACTED_KEYS.test(key)
        ? "[redacted]"
        : redactMetadata(item, depth + 1);
    }
    return result;
  }

  if (typeof value === "string") {
    return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
  }

  if (typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}

/**
 * Record an action. Never throws.
 *
 * Pass `client` to write inside an enclosing transaction — do that when the log
 * entry and its subject must land together or not at all (creating a company,
 * changing permissions). Omit it for observational logging such as a sign-in.
 */
export async function recordAuditLog(
  entry: AuditEntry,
  client: DbClient = prisma,
): Promise<void> {
  try {
    await client.auditLog.create({
      data: {
        action: entry.action,
        module: entry.module,
        companyId: entry.companyId ?? null,
        userId: entry.userId ?? null,
        actorEmail: entry.actorEmail ?? null,
        entityType: entry.entityType ?? null,
        entityId: entry.entityId ?? null,
        metadata: entry.metadata ? redactMetadata(entry.metadata) : undefined,
        ipAddress: entry.ipAddress ?? null,
        userAgent: entry.userAgent ?? null,
      },
    });
  } catch (error) {
    console.error("Failed to write audit log entry", {
      action: entry.action,
      module: entry.module,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
