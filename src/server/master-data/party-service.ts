import "server-only";
import { AccountNature, PartyType, Prisma } from "@prisma/client";
import { prisma, type DbClient } from "@/lib/db";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import { findStateByCode, gstinStateCode } from "@/lib/constants/india";
import { isZero, toStorageString } from "@/lib/money";
import type {
  CustomerInput,
  SupplierInput,
} from "@/lib/validation/master-data";
import { recordAuditLog } from "@/server/audit/audit-log";
import { MasterDataError } from "./errors";
import { allocateMasterCode } from "./master-code";
import {
  OPENING_SOURCE,
  postOpeningDelta,
  postedOpeningFor,
  resolveOpeningContext,
  resolveSystemAccountId,
  signedOpening,
} from "./opening-balance";

/**
 * Customers and suppliers.
 *
 * They are the same record with the sign flipped — one owes the business money,
 * the other is owed it — so they share every rule here rather than being
 * written twice and drifting apart. What differs is captured in `PARTY_KIND`:
 * the control account they post to, the sub-ledger they belong in, and the side
 * their opening balance normally sits on.
 */

export type PartyKind = "CUSTOMER" | "SUPPLIER";

const PARTY_KIND = {
  CUSTOMER: {
    partyType: PartyType.CUSTOMER,
    controlAccount: SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
    source: OPENING_SOURCE.CUSTOMER,
    sequenceKey: "CUSTOMER",
    entity: "Customer",
    module: "Customers",
    /** Receivable: they owe us. */
    defaultNature: AccountNature.DEBIT,
    noun: "customer",
  },
  SUPPLIER: {
    partyType: PartyType.SUPPLIER,
    controlAccount: SYSTEM_ACCOUNT.ACCOUNTS_PAYABLE,
    source: OPENING_SOURCE.SUPPLIER,
    sequenceKey: "SUPPLIER",
    entity: "Supplier",
    module: "Suppliers",
    /** Payable: we owe them. */
    defaultNature: AccountNature.CREDIT,
    noun: "supplier",
  },
} as const;

export function partyDefaultNature(kind: PartyKind): AccountNature {
  return PARTY_KIND[kind].defaultNature;
}

export const PARTY_AUDIT = {
  CREATED: "party.created",
  UPDATED: "party.updated",
  ARCHIVED: "party.archived",
  RESTORED: "party.restored",
  OPENING_ADJUSTED: "party.opening_adjusted",
} as const;

export type PartyRow = {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  email: string | null;
  gstin: string | null;
  city: string | null;
  stateCode: string | null;
  creditDays: number;
  creditLimit: string | null;
  openingBalance: string;
  openingNature: AccountNature;
  isActive: boolean;
  isArchived: boolean;
};

export type PartyListResult = {
  rows: PartyRow[];
  total: number;
  page: number;
  pageCount: number;
};

export const PARTY_PAGE_SIZE = 25;

type ListParams = {
  companyId: string;
  kind: PartyKind;
  query?: string;
  includeArchived?: boolean;
  page?: number;
};

export async function listParties(
  params: ListParams,
): Promise<PartyListResult> {
  const page = Math.max(1, params.page ?? 1);
  const query = params.query?.trim() ?? "";

  const where = {
    companyId: params.companyId,
    ...(params.includeArchived ? {} : { archivedAt: null }),
    ...(query.length >= 1
      ? {
          OR: [
            { name: { contains: query, mode: Prisma.QueryMode.insensitive } },
            { code: { contains: query, mode: Prisma.QueryMode.insensitive } },
            { phone: { contains: query } },
            { gstin: { contains: query, mode: Prisma.QueryMode.insensitive } },
          ],
        }
      : {}),
  };

  const select = {
    id: true,
    code: true,
    name: true,
    phone: true,
    email: true,
    gstin: true,
    city: true,
    stateCode: true,
    creditDays: true,
    openingBalance: true,
    openingNature: true,
    isActive: true,
    archivedAt: true,
  };

  const paging = {
    orderBy: { name: Prisma.SortOrder.asc },
    skip: (page - 1) * PARTY_PAGE_SIZE,
    take: PARTY_PAGE_SIZE,
  };

  // Branching on the kind rather than probing the result for a `creditLimit`
  // keeps both shapes fully typed: a supplier has no credit limit, and saying
  // so once here is clearer than narrowing it back out downstream.
  const [total, rows] =
    params.kind === "CUSTOMER"
      ? await Promise.all([
          prisma.customer.count({ where }),
          prisma.customer
            .findMany({
              where,
              select: { ...select, creditLimit: true },
              ...paging,
            })
            .then((records) =>
              records.map((record) => ({
                ...toRow(record),
                creditLimit: toStorageString(record.creditLimit),
              })),
            ),
        ])
      : await Promise.all([
          prisma.supplier.count({ where }),
          prisma.supplier
            .findMany({ where, select, ...paging })
            .then((records) => records.map(toRow)),
        ]);

  return {
    rows,
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PARTY_PAGE_SIZE)),
  };
}

function toRow(record: {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  email: string | null;
  gstin: string | null;
  city: string | null;
  stateCode: string | null;
  creditDays: number;
  openingBalance: Prisma.Decimal;
  openingNature: AccountNature;
  isActive: boolean;
  archivedAt: Date | null;
}): PartyRow {
  return {
    id: record.id,
    code: record.code,
    name: record.name,
    phone: record.phone,
    email: record.email,
    gstin: record.gstin,
    city: record.city,
    stateCode: record.stateCode,
    creditDays: record.creditDays,
    creditLimit: null,
    openingBalance: toStorageString(record.openingBalance),
    openingNature: record.openingNature,
    isActive: record.isActive,
    isArchived: record.archivedAt !== null,
  };
}

/**
 * The state a party is taxed in.
 *
 * Taken from the GSTIN when there is one, because that is the registration that
 * governs the supply; the typed state is only a fallback for an unregistered
 * party. Getting this wrong turns a CGST + SGST invoice into an IGST one.
 */
function resolvePlaceOfSupply(input: { gstin?: string; stateCode?: string }): {
  stateCode: string | null;
  state: string | null;
} {
  const fromGstin = input.gstin ? gstinStateCode(input.gstin) : null;
  const code = fromGstin ?? (input.stateCode || null);
  if (!code) return { stateCode: null, state: null };
  return { stateCode: code, state: findStateByCode(code)?.name ?? null };
}

function toRecordData(input: CustomerInput | SupplierInput) {
  const place = resolvePlaceOfSupply(input);
  return {
    name: input.name,
    phone: input.phone || null,
    email: input.email || null,
    gstin: input.gstin || null,
    pan: input.pan || null,
    addressLine1: input.addressLine1 || null,
    city: input.city || null,
    state: place.state,
    stateCode: place.stateCode,
    pincode: input.pincode || null,
    creditDays: input.creditDays,
    openingBalance: toStorageString(input.openingBalance),
    openingNature: input.openingNature,
    notes: input.notes || null,
  };
}

async function findParty(
  tx: DbClient,
  kind: PartyKind,
  companyId: string,
  id: string,
) {
  const select = {
    id: true,
    code: true,
    name: true,
    openingBalance: true,
    openingNature: true,
    archivedAt: true,
  };
  const record =
    kind === "CUSTOMER"
      ? await tx.customer.findFirst({ where: { id, companyId }, select })
      : await tx.supplier.findFirst({ where: { id, companyId }, select });

  if (!record) {
    throw new MasterDataError(
      `That ${PARTY_KIND[kind].noun} could not be found.`,
      "NOT_FOUND",
    );
  }
  return record;
}

async function assertNameIsFree(
  tx: DbClient,
  kind: PartyKind,
  companyId: string,
  name: string,
  excludeId?: string,
): Promise<void> {
  const where = {
    companyId,
    name: { equals: name, mode: Prisma.QueryMode.insensitive },
    ...(excludeId ? { id: { not: excludeId } } : {}),
  };
  const existing =
    kind === "CUSTOMER"
      ? await tx.customer.findFirst({ where, select: { id: true } })
      : await tx.supplier.findFirst({ where, select: { id: true } });

  if (existing) {
    throw new MasterDataError(
      `A ${PARTY_KIND[kind].noun} named "${name}" already exists.`,
      "DUPLICATE_NAME",
      "name",
    );
  }
}

export async function createParty(params: {
  companyId: string;
  kind: PartyKind;
  userId: string;
  actorEmail: string;
  input: CustomerInput | SupplierInput;
}): Promise<{
  id: string;
  code: string;
  openingEntry: string | null;
  /**
   * Set when the opening balance could not be dated to the start of the year
   * because that month is closed, so the screen can say so rather than leaving
   * the figure quietly sitting on a date nobody chose.
   */
  openingDeferredTo: string | null;
}> {
  const config = PARTY_KIND[params.kind];

  return prisma.$transaction(async (tx) => {
    await assertNameIsFree(
      tx,
      params.kind,
      params.companyId,
      params.input.name,
    );

    // Only a party that brings a balance with it needs somewhere to post one.
    // Resolved unconditionally, keeping an address book required an open
    // accounting period: with every month of the year closed, a shop could add
    // a product carrying no stock but not a customer owing nothing.
    const target = signedOpening(
      params.input.openingBalance,
      params.input.openingNature,
    );
    const opening = isZero(target)
      ? null
      : await resolveOpeningContext(tx, params.companyId);

    const controlAccountId = await resolveSystemAccountId(
      tx,
      params.companyId,
      config.controlAccount,
    );

    const code = await allocateMasterCode(tx, {
      companyId: params.companyId,
      key: config.sequenceKey,
      isTaken: async (candidate) => {
        const where = { companyId: params.companyId, code: candidate };
        const existing =
          params.kind === "CUSTOMER"
            ? await tx.customer.findFirst({ where, select: { id: true } })
            : await tx.supplier.findFirst({ where, select: { id: true } });
        return existing !== null;
      },
    });

    const data = {
      ...toRecordData(params.input),
      companyId: params.companyId,
      code,
    };
    const created =
      params.kind === "CUSTOMER"
        ? await tx.customer.create({
            data: {
              ...data,
              creditLimit: toStorageString(
                "creditLimit" in params.input ? params.input.creditLimit : 0,
              ),
            },
            select: { id: true, code: true },
          })
        : await tx.supplier.create({ data, select: { id: true, code: true } });

    const entry = opening
      ? await postOpeningDelta(tx, {
          companyId: params.companyId,
          context: opening,
          accountId: controlAccountId,
          partyType: config.partyType,
          partyId: created.id,
          source: config.source,
          sourceId: created.id,
          target,
          posted: 0,
          narration: `Opening balance — ${params.input.name}`,
          createdById: params.userId,
        })
      : null;

    await recordAuditLog(
      {
        action: PARTY_AUDIT.CREATED,
        module: config.module,
        companyId: params.companyId,
        userId: params.userId,
        actorEmail: params.actorEmail,
        entityType: config.entity,
        entityId: created.id,
        metadata: {
          code: created.code,
          name: params.input.name,
          openingBalance: toStorageString(params.input.openingBalance),
          openingNature: params.input.openingNature,
          openingEntry: entry?.entryNumber ?? null,
        },
      },
      tx,
    );

    return {
      id: created.id,
      code: created.code,
      openingEntry: entry?.entryNumber ?? null,
      openingDeferredTo:
        opening?.deferred && entry
          ? opening.date.toISOString().slice(0, 10)
          : null,
    };
  });
}

export async function updateParty(params: {
  companyId: string;
  kind: PartyKind;
  partyId: string;
  userId: string;
  actorEmail: string;
  input: CustomerInput | SupplierInput;
}): Promise<{ openingEntry: string | null }> {
  const config = PARTY_KIND[params.kind];

  return prisma.$transaction(async (tx) => {
    const existing = await findParty(
      tx,
      params.kind,
      params.companyId,
      params.partyId,
    );
    await assertNameIsFree(
      tx,
      params.kind,
      params.companyId,
      params.input.name,
      params.partyId,
    );

    const data = toRecordData(params.input);
    if (params.kind === "CUSTOMER") {
      await tx.customer.update({
        where: { id: params.partyId },
        data: {
          ...data,
          creditLimit: toStorageString(
            "creditLimit" in params.input ? params.input.creditLimit : 0,
          ),
        },
      });
    } else {
      await tx.supplier.update({ where: { id: params.partyId }, data });
    }

    // Only touch the ledger when the position actually moved. Editing a phone
    // number must not put a journal entry into the books.
    const target = signedOpening(
      params.input.openingBalance,
      params.input.openingNature,
    );
    const previous = signedOpening(
      existing.openingBalance,
      existing.openingNature,
    );

    let entry: { entryNumber: string; delta: string } | null = null;
    if (!target.equals(previous)) {
      const opening = await resolveOpeningContext(tx, params.companyId);
      const controlAccountId = await resolveSystemAccountId(
        tx,
        params.companyId,
        config.controlAccount,
      );
      // Measured against the ledger, not against the row we just overwrote, so
      // a correction posted by any other route is taken into account.
      const posted = await postedOpeningFor(tx, {
        companyId: params.companyId,
        accountId: controlAccountId,
        source: config.source,
        sourceId: params.partyId,
      });

      entry = await postOpeningDelta(tx, {
        companyId: params.companyId,
        context: opening,
        accountId: controlAccountId,
        partyType: config.partyType,
        partyId: params.partyId,
        source: config.source,
        sourceId: params.partyId,
        target,
        posted,
        narration: `Opening balance correction — ${params.input.name}`,
        createdById: params.userId,
      });
    }

    await recordAuditLog(
      {
        action: entry ? PARTY_AUDIT.OPENING_ADJUSTED : PARTY_AUDIT.UPDATED,
        module: config.module,
        companyId: params.companyId,
        userId: params.userId,
        actorEmail: params.actorEmail,
        entityType: config.entity,
        entityId: params.partyId,
        metadata: {
          code: existing.code,
          name: params.input.name,
          ...(entry
            ? { correctionEntry: entry.entryNumber, delta: entry.delta }
            : {}),
        },
      },
      tx,
    );

    return { openingEntry: entry?.entryNumber ?? null };
  });
}

/**
 * Archives or restores a party.
 *
 * There is no delete. A party with an opening balance is already named in a
 * posted journal entry, and an entry that cannot say who it was with is not an
 * audit trail. Archiving hides the record from pickers and lists while leaving
 * every reference to it intact.
 */
export async function setPartyArchived(params: {
  companyId: string;
  kind: PartyKind;
  partyId: string;
  archived: boolean;
  userId: string;
  actorEmail: string;
}): Promise<void> {
  const config = PARTY_KIND[params.kind];

  await prisma.$transaction(async (tx) => {
    const existing = await findParty(
      tx,
      params.kind,
      params.companyId,
      params.partyId,
    );

    const data = {
      archivedAt: params.archived ? new Date() : null,
      isActive: !params.archived,
    };

    if (params.kind === "CUSTOMER") {
      await tx.customer.update({ where: { id: params.partyId }, data });
    } else {
      await tx.supplier.update({ where: { id: params.partyId }, data });
    }

    await recordAuditLog(
      {
        action: params.archived ? PARTY_AUDIT.ARCHIVED : PARTY_AUDIT.RESTORED,
        module: config.module,
        companyId: params.companyId,
        userId: params.userId,
        actorEmail: params.actorEmail,
        entityType: config.entity,
        entityId: params.partyId,
        metadata: { code: existing.code, name: existing.name },
      },
      tx,
    );
  });
}
