"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { DatasetKey } from "@/lib/import/datasets";
import { recordAuditLog } from "@/server/audit/audit-log";
import { fail, ok, type ActionResult } from "@/server/auth/action-result";
import { assertPermission } from "@/server/auth/context";
import { billingRefusal } from "@/server/billing/guards";
import { requireSameOrigin } from "@/server/security/request-context";
import {
  commitImport,
  previewImport,
  ImportError,
  type ImportPreview,
  type ImportResult,
} from "./import-service";

/**
 * Import actions.
 *
 * Both are gated on `data.import` rather than on the permission for the thing
 * being created. Somebody allowed to add a product one at a time is not
 * thereby allowed to add four hundred with opening balances attached — the
 * second is a different act, and one whose mistakes take a long afternoon to
 * unpick.
 *
 * The file is passed as text rather than held on the server between the two
 * calls. A half-uploaded file sitting in memory against a session is a thing
 * to expire, evict and clean up; re-sending it costs a moment and removes all
 * of that. It also means the preview and the commit read exactly the same
 * bytes, so what somebody approved is what runs.
 */

const schema = z.object({
  dataset: z.enum(["products", "customers", "suppliers"]),
  // Generous, because a spreadsheet of five thousand products is the case this
  // exists for. The row cap in the service is the real limit.
  text: z.string().min(1, "Choose a file first.").max(8_000_000),
});

export async function previewImportAction(
  input: unknown,
): Promise<ActionResult<ImportPreview>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("data.import");

  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return fail(
      parsed.error.issues[0]?.message ?? "That file could not be read.",
    );
  }

  try {
    return ok(
      await previewImport({
        companyId: context.company.id,
        dataset: parsed.data.dataset as DatasetKey,
        text: parsed.data.text,
      }),
    );
  } catch (error) {
    if (error instanceof ImportError) return fail(error.message);
    throw error;
  }
}

export async function commitImportAction(
  input: unknown,
): Promise<ActionResult<ImportResult>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("data.import");

  // Creating a product through the form asks this; creating four hundred
  // through a file did not. That is the comparison that matters, because this
  // calls the very same `createProduct` in a loop — a shop whose subscription
  // had lapsed was refused one and allowed the four hundred.
  //
  // Not every module asks: the ledger-side actions do not, and whether a
  // read-only subscription may still post a journal entry or close a period is
  // a question about the product rather than about this file. This matches the
  // path it duplicates and leaves that question where it was.
  const refusal = await billingRefusal(context.company.id, {});
  if (refusal) return refusal;

  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return fail(
      parsed.error.issues[0]?.message ?? "That file could not be read.",
    );
  }

  const dataset = parsed.data.dataset as DatasetKey;

  try {
    const result = await commitImport({
      companyId: context.company.id,
      userId: context.user.id,
      actorEmail: context.user.email,
      dataset,
      text: parsed.data.text,
    });

    // Hundreds of records appearing at once is worth being able to account for
    // later, especially when some of them posted opening balances.
    await recordAuditLog({
      action: "company.data_imported",
      module: "Settings",
      companyId: context.company.id,
      userId: context.user.id,
      actorEmail: context.user.email,
      entityType: "Company",
      entityId: context.company.id,
      metadata: {
        dataset,
        created: result.created,
        skipped: result.skipped,
        failed: result.failed.length,
      },
    });

    revalidatePath("/app/settings/import");
    revalidatePath(
      dataset === "products"
        ? "/app/products"
        : dataset === "customers"
          ? "/app/customers"
          : "/app/suppliers",
    );

    return ok(result);
  } catch (error) {
    if (error instanceof ImportError) return fail(error.message);
    throw error;
  }
}
