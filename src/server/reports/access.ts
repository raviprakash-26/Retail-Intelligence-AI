import "server-only";
import { findReport, type ReportDefinition } from "@/lib/reports/catalogue";
import { FEATURE_LABEL } from "@/lib/billing/entitlements";
import type { CompanyContext } from "@/server/auth/context";
import { featureGate } from "@/server/billing/guards";

/**
 * Whether this member may run this report, and on what.
 *
 * Written once and used by both the page and the download, so the file cannot
 * be reachable by somebody the screen would have refused. Splitting those two
 * checks is how an export endpoint quietly becomes the way around a permission.
 *
 * Three questions, and the order matters only in what it tells the person:
 * a report they have no permission for is not theirs to see at all, whereas one
 * their plan does not include is an upgrade they could choose to make.
 */

export type ReportAccess =
  | { allowed: true; definition: ReportDefinition }
  | {
      allowed: false;
      definition: ReportDefinition;
      reason: "permission" | "feature";
      message: string;
      /** Set when the refusal is a plan gate rather than a role. */
      availableOn: string | null;
      /** The plan they are on now, so the refusal can name both ends. */
      planName: string | null;
    }
  | { allowed: false; definition: null; reason: "unknown"; message: string };

export async function authorizeReport(params: {
  context: CompanyContext;
  key: string;
}): Promise<ReportAccess> {
  const definition = findReport(params.key);
  if (!definition) {
    return {
      allowed: false,
      definition: null,
      reason: "unknown",
      message: "That report does not exist.",
    };
  }

  if (!params.context.permissions.has("reports.view")) {
    return {
      allowed: false,
      definition,
      reason: "permission",
      message: "You do not have access to reports.",
      availableOn: null,
      planName: null,
    };
  }

  // The reports permission opens the cabinet; each report still asks for its
  // own drawer. Without this, `reports.view` would silently be a way to read
  // every module in the product.
  if (!params.context.permissions.has(definition.permission)) {
    return {
      allowed: false,
      definition,
      reason: "permission",
      message: `You do not have access to ${definition.title.toLowerCase()}.`,
      availableOn: null,
      planName: null,
    };
  }

  if (definition.feature) {
    const gate = await featureGate(
      params.context.company.id,
      definition.feature,
    );
    if (!gate.included) {
      return {
        allowed: false,
        definition,
        reason: "feature",
        message: `${FEATURE_LABEL[definition.feature] ?? definition.title} is not included in your current plan.`,
        availableOn: gate.availableOn,
        planName: gate.entitlements.planName,
      };
    }
  }

  return { allowed: true, definition };
}
