"use server";
import { logger } from "@/lib/observability/logger";

import { revalidatePath } from "next/cache";
import {
  categorySchema,
  customerSchema,
  employeeSchema,
  productSchema,
  supplierSchema,
  unitSchema,
  type CategoryInput,
  type CustomerInput,
  type EmployeeInput,
  type ProductInput,
  type SupplierInput,
  type UnitInput,
} from "@/lib/validation/master-data";
import {
  ACTION_ERROR,
  fail,
  ok,
  zodFieldErrors,
  type ActionResult,
} from "@/server/auth/action-result";
import { billingRefusal } from "@/server/billing/guards";
import { assertPermission } from "@/server/auth/context";
import {
  NoFiscalPeriodError,
  PeriodClosedError,
} from "@/server/accounting/post-journal-entry";
import { requireSameOrigin } from "@/server/security/request-context";
import { MasterDataError } from "./errors";
import { OpeningBalanceError } from "./opening-balance";
import { createEmployee, updateEmployee } from "./employee-service";
import {
  createParty,
  setPartyArchived,
  updateParty,
  type PartyKind,
} from "./party-service";
import {
  createProduct,
  setProductArchived,
  updateProduct,
} from "./product-service";
import {
  archiveCategory,
  createCategory,
  createUnit,
  updateCategory,
  updateUnit,
} from "./taxonomy-service";

/**
 * Master-data actions.
 *
 * Each one asserts its permission first and takes `companyId` from the context
 * that assertion returns — never from an argument. A record id *is* accepted
 * from the client, but every service scopes its lookup by company, so an id
 * belonging to another tenant simply finds nothing.
 */

const MASTER_PATHS = [
  "/app",
  "/app/products",
  "/app/customers",
  "/app/suppliers",
  "/app/employees",
] as const;

function revalidateMasterData(): void {
  for (const path of MASTER_PATHS) revalidatePath(path);
}

/**
 * Turns a service failure into something a form can render.
 *
 * The accounting errors are surfaced verbatim because they are actionable —
 * "the period is closed" tells the user exactly what to do next, where a
 * generic message would send them to support.
 */
function fromServiceError(error: unknown): ActionResult<never> {
  if (error instanceof MasterDataError) {
    return fail(error.message, {
      code: error.code,
      fieldErrors: error.field ? { [error.field]: error.message } : undefined,
    });
  }
  if (error instanceof OpeningBalanceError) {
    return fail(error.message, { code: error.code });
  }
  if (
    error instanceof PeriodClosedError ||
    error instanceof NoFiscalPeriodError
  ) {
    return fail(error.message, { code: "PERIOD_UNAVAILABLE" });
  }
  logger.error("Master data action failed", { module: "MasterData", error });
  return fail("Something went wrong. Nothing was saved — please try again.", {
    code: ACTION_ERROR.UNEXPECTED,
  });
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export async function createProductAction(input: ProductInput): Promise<
  ActionResult<{
    id: string;
    sku: string;
    openingEntry: string | null;
    openingDeferredTo: string | null;
  }>
> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("products.manage");

  const refusal = await billingRefusal(context.company.id, {
    limit: "productsPerCompany",
  });
  if (refusal) return refusal;
  const parsed = productSchema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the details below.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  try {
    const product = await createProduct({
      companyId: context.company.id,
      userId: context.user.id,
      actorEmail: context.user.email,
      input: parsed.data,
    });
    revalidateMasterData();
    return ok(product);
  } catch (error) {
    return fromServiceError(error);
  }
}

export async function updateProductAction(
  productId: string,
  input: ProductInput,
): Promise<ActionResult<{ saved: true }>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("products.manage");
  const parsed = productSchema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the details below.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  try {
    await updateProduct({
      companyId: context.company.id,
      productId,
      userId: context.user.id,
      actorEmail: context.user.email,
      input: parsed.data,
    });
    revalidateMasterData();
    return ok({ saved: true });
  } catch (error) {
    return fromServiceError(error);
  }
}

export async function setProductArchivedAction(
  productId: string,
  archived: boolean,
): Promise<ActionResult<{ saved: true }>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("products.manage");
  try {
    await setProductArchived({
      companyId: context.company.id,
      productId,
      archived,
      userId: context.user.id,
      actorEmail: context.user.email,
    });
    revalidateMasterData();
    return ok({ saved: true });
  } catch (error) {
    return fromServiceError(error);
  }
}

// ---------------------------------------------------------------------------
// Customers and suppliers
// ---------------------------------------------------------------------------

/** Customers and suppliers are guarded by different permissions. */
const PARTY_PERMISSION = {
  CUSTOMER: { view: "customers.view", manage: "customers.manage" },
  SUPPLIER: { view: "suppliers.view", manage: "suppliers.manage" },
} as const;

export async function createPartyAction(
  kind: PartyKind,
  input: CustomerInput | SupplierInput,
): Promise<
  ActionResult<{
    id: string;
    code: string;
    openingEntry: string | null;
    openingDeferredTo: string | null;
  }>
> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission(PARTY_PERMISSION[kind].manage);

  const refusal = await billingRefusal(context.company.id, {});
  if (refusal) return refusal;
  const schema = kind === "CUSTOMER" ? customerSchema : supplierSchema;
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the details below.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  try {
    const party = await createParty({
      companyId: context.company.id,
      kind,
      userId: context.user.id,
      actorEmail: context.user.email,
      input: parsed.data,
    });
    revalidateMasterData();
    return ok(party);
  } catch (error) {
    return fromServiceError(error);
  }
}

export async function updatePartyAction(
  kind: PartyKind,
  partyId: string,
  input: CustomerInput | SupplierInput,
): Promise<ActionResult<{ openingEntry: string | null }>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission(PARTY_PERMISSION[kind].manage);

  // Editing a party can post. Changing the opening balance puts an "Opening
  // balance correction" into the books through the same `postOpeningDelta`
  // that `createParty` uses for the original — so the two routes to one entry
  // have to ask the same question, and only one of them was.
  const refusal = await billingRefusal(context.company.id, {});
  if (refusal) return refusal;
  const schema = kind === "CUSTOMER" ? customerSchema : supplierSchema;
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the details below.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  try {
    const result = await updateParty({
      companyId: context.company.id,
      kind,
      partyId,
      userId: context.user.id,
      actorEmail: context.user.email,
      input: parsed.data,
    });
    revalidateMasterData();
    return ok(result);
  } catch (error) {
    return fromServiceError(error);
  }
}

export async function setPartyArchivedAction(
  kind: PartyKind,
  partyId: string,
  archived: boolean,
): Promise<ActionResult<{ saved: true }>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission(PARTY_PERMISSION[kind].manage);
  try {
    await setPartyArchived({
      companyId: context.company.id,
      kind,
      partyId,
      archived,
      userId: context.user.id,
      actorEmail: context.user.email,
    });
    revalidateMasterData();
    return ok({ saved: true });
  } catch (error) {
    return fromServiceError(error);
  }
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

export async function createEmployeeAction(
  input: EmployeeInput,
): Promise<ActionResult<{ id: string; employeeCode: string }>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("employees.manage");

  const refusal = await billingRefusal(context.company.id, {});
  if (refusal) return refusal;
  const parsed = employeeSchema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the details below.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  try {
    const employee = await createEmployee({
      companyId: context.company.id,
      userId: context.user.id,
      actorEmail: context.user.email,
      input: parsed.data,
    });
    revalidateMasterData();
    return ok(employee);
  } catch (error) {
    return fromServiceError(error);
  }
}

export async function updateEmployeeAction(
  employeeId: string,
  input: EmployeeInput,
): Promise<ActionResult<{ saved: true }>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("employees.manage");
  const parsed = employeeSchema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the details below.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  try {
    await updateEmployee({
      companyId: context.company.id,
      employeeId,
      userId: context.user.id,
      actorEmail: context.user.email,
      input: parsed.data,
    });
    revalidateMasterData();
    return ok({ saved: true });
  } catch (error) {
    return fromServiceError(error);
  }
}

// ---------------------------------------------------------------------------
// Categories and units
// ---------------------------------------------------------------------------

export async function createCategoryAction(
  input: CategoryInput,
): Promise<ActionResult<{ id: string }>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("products.manage");

  const refusal = await billingRefusal(context.company.id, {});
  if (refusal) return refusal;
  const parsed = categorySchema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the details below.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  try {
    const category = await createCategory({
      companyId: context.company.id,
      userId: context.user.id,
      actorEmail: context.user.email,
      input: parsed.data,
    });
    revalidateMasterData();
    return ok(category);
  } catch (error) {
    return fromServiceError(error);
  }
}

export async function updateCategoryAction(
  categoryId: string,
  input: CategoryInput,
): Promise<ActionResult<{ saved: true }>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("products.manage");
  const parsed = categorySchema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the details below.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  try {
    await updateCategory({
      companyId: context.company.id,
      categoryId,
      userId: context.user.id,
      actorEmail: context.user.email,
      input: parsed.data,
    });
    revalidateMasterData();
    return ok({ saved: true });
  } catch (error) {
    return fromServiceError(error);
  }
}

export async function archiveCategoryAction(
  categoryId: string,
): Promise<ActionResult<{ saved: true }>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("products.manage");
  try {
    await archiveCategory({
      companyId: context.company.id,
      categoryId,
      userId: context.user.id,
      actorEmail: context.user.email,
    });
    revalidateMasterData();
    return ok({ saved: true });
  } catch (error) {
    return fromServiceError(error);
  }
}

export async function createUnitAction(
  input: UnitInput,
): Promise<ActionResult<{ id: string }>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("products.manage");

  const refusal = await billingRefusal(context.company.id, {});
  if (refusal) return refusal;
  const parsed = unitSchema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the details below.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  try {
    const unit = await createUnit({
      companyId: context.company.id,
      userId: context.user.id,
      actorEmail: context.user.email,
      input: parsed.data,
    });
    revalidateMasterData();
    return ok(unit);
  } catch (error) {
    return fromServiceError(error);
  }
}

export async function updateUnitAction(
  unitId: string,
  input: UnitInput,
): Promise<ActionResult<{ precisionLocked: boolean }>> {
  const originError = await requireSameOrigin();
  if (originError) return originError;

  const context = await assertPermission("products.manage");
  const parsed = unitSchema.safeParse(input);
  if (!parsed.success) {
    return fail("Check the details below.", {
      code: ACTION_ERROR.INVALID_INPUT,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    });
  }

  try {
    const result = await updateUnit({
      companyId: context.company.id,
      unitId,
      userId: context.user.id,
      actorEmail: context.user.email,
      input: parsed.data,
    });
    revalidateMasterData();
    return ok(result);
  } catch (error) {
    return fromServiceError(error);
  }
}
