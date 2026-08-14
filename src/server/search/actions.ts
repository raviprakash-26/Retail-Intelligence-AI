"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { getCompanyContext } from "@/server/auth/context";
import { assertSameOrigin } from "@/server/security/request-context";
import {
  FISCAL_YEAR_COOKIE,
  listFiscalYears,
} from "@/server/fiscal/fiscal-service";
import { markRead } from "@/server/notifications/notification-service";
import {
  globalSearch,
  type SearchResult,
  type SearchResultKind,
} from "./global-search";

/**
 * Shell actions: search, fiscal-year selection and notification reads.
 *
 * Each resolves the tenant from the session first, so none of them can be
 * pointed at another company by manipulating an argument.
 */

/** Maps permissions to the record types a member is allowed to find. */
function searchableKinds(
  permissions: ReadonlySet<string>,
): Set<SearchResultKind> {
  const kinds = new Set<SearchResultKind>();
  if (permissions.has("customers.view")) kinds.add("customer");
  if (permissions.has("suppliers.view")) kinds.add("supplier");
  if (permissions.has("products.view")) kinds.add("product");
  if (permissions.has("accounting.view")) kinds.add("account");
  return kinds;
}

export async function globalSearchAction(
  query: string,
): Promise<SearchResult[]> {
  const context = await getCompanyContext();
  if (!context) return [];

  return globalSearch({
    companyId: context.company.id,
    query,
    allowed: searchableKinds(context.permissions),
  });
}

/**
 * Switches the working fiscal year.
 *
 * The id is validated against this company's own years before it is stored, so
 * a hand-edited cookie cannot point the session at another tenant's year.
 */
export async function setFiscalYearAction(
  fiscalYearId: string,
): Promise<{ ok: boolean }> {
  await assertSameOrigin();

  const context = await getCompanyContext();
  if (!context) return { ok: false };

  const years = await listFiscalYears(context.company.id);
  if (!years.some((year) => year.id === fiscalYearId)) {
    return { ok: false };
  }

  const cookieStore = await cookies();
  cookieStore.set(FISCAL_YEAR_COOKIE, fiscalYearId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });

  revalidatePath("/app");
  return { ok: true };
}

export async function markNotificationsReadAction(
  notificationIds?: string[],
): Promise<{ ok: boolean; count: number }> {
  await assertSameOrigin();

  const context = await getCompanyContext();
  if (!context) return { ok: false, count: 0 };

  const count = await markRead({
    companyId: context.company.id,
    userId: context.user.id,
    notificationIds,
  });

  revalidatePath("/app");
  return { ok: true, count };
}
