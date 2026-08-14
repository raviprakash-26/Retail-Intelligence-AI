import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountNature } from "@prisma/client";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import { trialBalanceIsBalanced } from "@/lib/accounting/double-entry";
import { subtract, toStorageString } from "@/lib/money";
import type { RegisterInput } from "@/lib/validation/auth";
import type {
  CustomerInput,
  EmployeeInput,
  ProductInput,
  SupplierInput,
} from "@/lib/validation/master-data";
import { registerOwner } from "@/server/auth/registration";
import {
  createEmployee,
  listEmployees,
  updateEmployee,
} from "@/server/master-data/employee-service";
import {
  createParty,
  listParties,
  setPartyArchived,
  updateParty,
} from "@/server/master-data/party-service";
import {
  createProduct,
  listProducts,
  setProductArchived,
  updateProduct,
} from "@/server/master-data/product-service";
import {
  createCategory,
  createUnit,
  getProductTaxonomy,
  updateUnit,
} from "@/server/master-data/taxonomy-service";
import { MasterDataError } from "@/server/master-data/errors";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

const prisma = testDb();
const createdCompanies: string[] = [];
const createdEmails: string[] = [];

function registrationInput(email: string, businessName: string): RegisterInput {
  return {
    account: {
      fullName: "Ravi Prakash",
      email,
      mobile: "9845012345",
      password: "MountainRiver42!",
      confirmPassword: "MountainRiver42!",
      acceptTerms: true,
    },
    business: {
      businessName,
      businessType: "SOLE_PROPRIETORSHIP",
      gstRegistration: "UNREGISTERED",
      gstin: "",
      pan: "",
      addressLine1: "42 Avenue Road",
      city: "Bengaluru",
      stateCode: "29",
      pincode: "560053",
    },
    accounting: {
      fiscalYearStartMonth: 4,
      currency: "INR",
      openingCashBalance: 0,
      openingBankBalance: 0,
      inventoryMethod: "WEIGHTED_AVERAGE",
      loadDemoData: false,
    },
  };
}

async function createCompany(businessName = "Master Data Mart") {
  const email = `md-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const result = await registerOwner(registrationInput(email, businessName));
  createdCompanies.push(result.companyId);
  return result;
}

function actor(company: { companyId: string; userId: string }) {
  return {
    companyId: company.companyId,
    userId: company.userId,
    actorEmail: "owner@example.com",
  };
}

function customerInput(overrides: Partial<CustomerInput> = {}): CustomerInput {
  return {
    name: "Sharma Provision Store",
    phone: "",
    email: "",
    gstin: "",
    pan: "",
    addressLine1: "",
    city: "",
    stateCode: "",
    pincode: "",
    creditDays: 30,
    creditLimit: 100000,
    openingBalance: 0,
    openingNature: "DEBIT",
    notes: "",
    ...overrides,
  };
}

function supplierInput(overrides: Partial<SupplierInput> = {}): SupplierInput {
  const { creditLimit: _ignored, ...base } = customerInput();
  return {
    ...base,
    name: "ABC Traders",
    openingNature: "CREDIT",
    ...overrides,
  };
}

function productInput(
  unitId: string,
  overrides: Partial<ProductInput> = {},
): ProductInput {
  return {
    sku: "RICE-25",
    name: "Sona Masoori Rice",
    description: "",
    barcode: "",
    hsnCode: "1006",
    categoryId: "",
    unitId,
    taxRateId: "",
    purchasePrice: 1450,
    sellingPrice: 1620,
    mrp: 0,
    isStockTracked: true,
    openingQuantity: 0,
    openingRate: 0,
    minStockLevel: 0,
    ...overrides,
  };
}

function employeeInput(overrides: Partial<EmployeeInput> = {}): EmployeeInput {
  return {
    name: "Suresh Kumar",
    email: "",
    phone: "",
    department: "Operations",
    designation: "Store Manager",
    joiningDate: "2025-06-01",
    exitDate: "",
    status: "ACTIVE",
    basicSalary: 28000,
    allowances: 4000,
    panNumber: "",
    bankAccountNo: "",
    ifsc: "",
    ...overrides,
  };
}

/** Net debit posted to one system account across every posted journal line. */
async function accountBalance(
  companyId: string,
  systemKey: string,
): Promise<string> {
  const account = await prisma.account.findFirst({
    where: { companyId, systemKey },
    select: { id: true },
  });
  if (!account) throw new Error(`Missing account ${systemKey}`);

  const totals = await prisma.journalLine.aggregate({
    where: { companyId, accountId: account.id, status: "POSTED" },
    _sum: { debit: true, credit: true },
  });
  return toStorageString(
    subtract(totals._sum.debit ?? 0, totals._sum.credit ?? 0),
  );
}

async function assertTrialBalances(companyId: string): Promise<void> {
  const lines = await prisma.journalLine.groupBy({
    by: ["accountId"],
    where: { companyId, status: "POSTED" },
    _sum: { debit: true, credit: true },
  });
  const trial = trialBalanceIsBalanced(
    lines.map((line) => ({
      debit: line._sum.debit ?? 0,
      credit: line._sum.credit ?? 0,
    })),
  );
  // Reported as the difference rather than a bare boolean: a failure that says
  // "expected true" tells you nothing about how far out the books are.
  expect(trial.difference.toString()).toBe("0");
  expect(trial.balanced).toBe(true);
}

async function firstUnitId(companyId: string): Promise<string> {
  const taxonomy = await getProductTaxonomy(companyId);
  const unit = taxonomy.units[0];
  if (!unit) throw new Error("Provisioning did not create any units");
  return unit.id;
}

beforeAll(async () => {
  await ensurePlatformData();
}, 60_000);

afterAll(async () => {
  for (const companyId of createdCompanies) {
    await purgeTestCompany(companyId).catch(() => undefined);
  }
  await purgeTestUsers(createdEmails);
  await disconnectTestDb();
});

describe("customer opening balances", () => {
  it("posts a balanced entry to receivables against capital", async () => {
    const company = await createCompany();
    const before = await accountBalance(
      company.companyId,
      SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
    );

    const result = await createParty({
      ...actor(company),
      kind: "CUSTOMER",
      input: customerInput({ openingBalance: 50000, openingNature: "DEBIT" }),
    });

    expect(result.openingEntry).not.toBeNull();
    expect(result.code).toMatch(/^CUS-\d{4}$/);

    const after = await accountBalance(
      company.companyId,
      SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
    );
    expect(toStorageString(subtract(after, before))).toBe(
      toStorageString(50000),
    );

    await assertTrialBalances(company.companyId);
  });

  it("attributes the line to the customer so a statement can be produced", async () => {
    const company = await createCompany();
    const created = await createParty({
      ...actor(company),
      kind: "CUSTOMER",
      input: customerInput({ openingBalance: 12500 }),
    });

    const line = await prisma.journalLine.findFirst({
      where: {
        companyId: company.companyId,
        partyType: "CUSTOMER",
        partyId: created.id,
      },
      select: { debit: true, credit: true },
    });

    expect(line).not.toBeNull();
    expect(toStorageString(line?.debit ?? 0)).toBe(toStorageString(12500));
  });

  it("posts nothing at all when the opening balance is zero", async () => {
    const company = await createCompany();
    const entriesBefore = await prisma.journalEntry.count({
      where: { companyId: company.companyId },
    });

    const created = await createParty({
      ...actor(company),
      kind: "CUSTOMER",
      input: customerInput({ openingBalance: 0 }),
    });

    expect(created.openingEntry).toBeNull();
    expect(
      await prisma.journalEntry.count({
        where: { companyId: company.companyId },
      }),
    ).toBe(entriesBefore);
  });

  it("posts only the difference when an opening balance is corrected", async () => {
    const company = await createCompany();
    const created = await createParty({
      ...actor(company),
      kind: "CUSTOMER",
      input: customerInput({ openingBalance: 50000 }),
    });

    const result = await updateParty({
      ...actor(company),
      kind: "CUSTOMER",
      partyId: created.id,
      input: customerInput({ openingBalance: 65000 }),
    });

    expect(result.openingEntry).not.toBeNull();
    // Not 65,000 and not 115,000: the correction is the delta only.
    expect(
      await accountBalance(
        company.companyId,
        SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
      ),
    ).toBe(toStorageString(65000));

    await assertTrialBalances(company.companyId);
  });

  it("leaves the original entry standing rather than rewriting it", async () => {
    const company = await createCompany();
    const created = await createParty({
      ...actor(company),
      kind: "CUSTOMER",
      input: customerInput({ openingBalance: 50000 }),
    });

    await updateParty({
      ...actor(company),
      kind: "CUSTOMER",
      partyId: created.id,
      input: customerInput({ openingBalance: 20000 }),
    });

    const entries = await prisma.journalEntry.findMany({
      where: {
        companyId: company.companyId,
        sourceType: "CUSTOMER_OPENING",
        sourceId: created.id,
      },
      select: { totalDebit: true, totalCredit: true },
      orderBy: { createdAt: "asc" },
    });

    expect(entries).toHaveLength(2);
    expect(toStorageString(entries[0]?.totalDebit ?? 0)).toBe(
      toStorageString(50000),
    );
    expect(toStorageString(entries[1]?.totalDebit ?? 0)).toBe(
      toStorageString(30000),
    );
  });

  it("posts nothing when an edit does not touch the balance", async () => {
    const company = await createCompany();
    const created = await createParty({
      ...actor(company),
      kind: "CUSTOMER",
      input: customerInput({ openingBalance: 50000 }),
    });

    const before = await prisma.journalEntry.count({
      where: { companyId: company.companyId },
    });

    const result = await updateParty({
      ...actor(company),
      kind: "CUSTOMER",
      partyId: created.id,
      input: customerInput({ openingBalance: 50000, phone: "9845012345" }),
    });

    expect(result.openingEntry).toBeNull();
    expect(
      await prisma.journalEntry.count({
        where: { companyId: company.companyId },
      }),
    ).toBe(before);
  });

  it("flips the sign correctly when a receivable becomes an advance held", async () => {
    const company = await createCompany();
    const created = await createParty({
      ...actor(company),
      kind: "CUSTOMER",
      input: customerInput({ openingBalance: 50000, openingNature: "DEBIT" }),
    });

    await updateParty({
      ...actor(company),
      kind: "CUSTOMER",
      partyId: created.id,
      input: customerInput({ openingBalance: 10000, openingNature: "CREDIT" }),
    });

    expect(
      await accountBalance(
        company.companyId,
        SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
      ),
    ).toBe(toStorageString(-10000));

    await assertTrialBalances(company.companyId);
  });
});

describe("supplier opening balances", () => {
  it("credits payables and debits capital", async () => {
    const company = await createCompany();
    await createParty({
      ...actor(company),
      kind: "SUPPLIER",
      input: supplierInput({ openingBalance: 30000, openingNature: "CREDIT" }),
    });

    // Net debit on payables is negative: the business owes money.
    expect(
      await accountBalance(company.companyId, SYSTEM_ACCOUNT.ACCOUNTS_PAYABLE),
    ).toBe(toStorageString(-30000));

    await assertTrialBalances(company.companyId);
  });

  it("numbers suppliers on their own series", async () => {
    const company = await createCompany();
    const first = await createParty({
      ...actor(company),
      kind: "SUPPLIER",
      input: supplierInput({ name: "ABC Traders" }),
    });
    const second = await createParty({
      ...actor(company),
      kind: "SUPPLIER",
      input: supplierInput({ name: "Sri Venkateshwara Wholesale" }),
    });

    expect(first.code).toBe("SUP-0001");
    expect(second.code).toBe("SUP-0002");
  });

  it("walks past a code an import or an older seed already used", async () => {
    const company = await createCompany();
    // A record whose code the numbering series has never issued — exactly what
    // an import leaves behind. The next allocation must step over it rather
    // than failing on the unique index.
    await prisma.supplier.create({
      data: {
        companyId: company.companyId,
        code: "SUP-0001",
        name: "Imported Supplier",
      },
    });

    const created = await createParty({
      ...actor(company),
      kind: "SUPPLIER",
      input: supplierInput({ name: "Fresh Supplier" }),
    });

    expect(created.code).toBe("SUP-0002");
  });

  it("refuses a duplicate name regardless of case", async () => {
    const company = await createCompany();
    await createParty({
      ...actor(company),
      kind: "SUPPLIER",
      input: supplierInput({ name: "ABC Traders" }),
    });

    await expect(
      createParty({
        ...actor(company),
        kind: "SUPPLIER",
        input: supplierInput({ name: "abc traders" }),
      }),
    ).rejects.toThrow(MasterDataError);
  });
});

describe("products and opening stock", () => {
  it("posts stock value to inventory and opens the stock ledger", async () => {
    const company = await createCompany();
    const unitId = await firstUnitId(company.companyId);

    const created = await createProduct({
      ...actor(company),
      input: productInput(unitId, { openingQuantity: 40, openingRate: 1450 }),
    });

    expect(created.openingEntry).not.toBeNull();
    expect(
      await accountBalance(company.companyId, SYSTEM_ACCOUNT.INVENTORY),
    ).toBe(toStorageString(58000));

    const balance = await prisma.inventoryBalance.findFirst({
      where: { companyId: company.companyId, productId: created.id },
      select: { quantity: true, stockValue: true },
    });
    expect(toStorageString(balance?.quantity ?? 0)).toBe(toStorageString(40));
    expect(toStorageString(balance?.stockValue ?? 0)).toBe(
      toStorageString(58000),
    );

    const movements = await prisma.inventoryMovement.count({
      where: { companyId: company.companyId, productId: created.id },
    });
    expect(movements).toBe(1);

    await assertTrialBalances(company.companyId);
  });

  it("creates no stock rows and no entry for a service", async () => {
    const company = await createCompany();
    const unitId = await firstUnitId(company.companyId);

    const created = await createProduct({
      ...actor(company),
      input: productInput(unitId, {
        sku: "DELIVERY",
        name: "Home delivery",
        isStockTracked: false,
      }),
    });

    expect(created.openingEntry).toBeNull();
    expect(
      await prisma.inventoryBalance.count({
        where: { companyId: company.companyId, productId: created.id },
      }),
    ).toBe(0);
  });

  it("refuses a duplicate SKU", async () => {
    const company = await createCompany();
    const unitId = await firstUnitId(company.companyId);
    await createProduct({ ...actor(company), input: productInput(unitId) });

    await expect(
      createProduct({
        ...actor(company),
        input: productInput(unitId, { name: "Another rice" }),
      }),
    ).rejects.toThrow(/already exists/);
  });

  it("refuses to un-track a product that already holds stock", async () => {
    const company = await createCompany();
    const unitId = await firstUnitId(company.companyId);
    const created = await createProduct({
      ...actor(company),
      input: productInput(unitId, { openingQuantity: 40, openingRate: 1450 }),
    });

    await expect(
      updateProduct({
        ...actor(company),
        productId: created.id,
        input: productInput(unitId, { isStockTracked: false }),
      }),
    ).rejects.toThrow(/already carries stock/);
  });

  it("leaves opening stock untouched when the product is edited", async () => {
    const company = await createCompany();
    const unitId = await firstUnitId(company.companyId);
    const created = await createProduct({
      ...actor(company),
      input: productInput(unitId, { openingQuantity: 40, openingRate: 1450 }),
    });

    await updateProduct({
      ...actor(company),
      productId: created.id,
      input: productInput(unitId, {
        sellingPrice: 1700,
        // The form disables these; a hand-crafted request must not get through
        // either, or the ledger and the stock card would part company.
        openingQuantity: 999,
        openingRate: 9999,
      }),
    });

    const product = await prisma.product.findUniqueOrThrow({
      where: { id: created.id },
      select: { openingQuantity: true, sellingPrice: true },
    });
    expect(toStorageString(product.openingQuantity)).toBe(toStorageString(40));
    expect(toStorageString(product.sellingPrice)).toBe(toStorageString(1700));
    expect(
      await accountBalance(company.companyId, SYSTEM_ACCOUNT.INVENTORY),
    ).toBe(toStorageString(58000));
  });

  it("rejects a unit belonging to another company", async () => {
    const [mine, theirs] = await Promise.all([
      createCompany("Mine"),
      createCompany("Theirs"),
    ]);
    const foreignUnitId = await firstUnitId(theirs.companyId);

    await expect(
      createProduct({ ...actor(mine), input: productInput(foreignUnitId) }),
    ).rejects.toThrow(/could not be found/);
  });
});

describe("tenant isolation", () => {
  it("never returns another company's records", async () => {
    const [mine, theirs] = await Promise.all([
      createCompany("Isolation A"),
      createCompany("Isolation B"),
    ]);

    await createParty({
      ...actor(theirs),
      kind: "CUSTOMER",
      input: customerInput({ name: "Their Secret Customer" }),
    });

    const listed = await listParties({
      companyId: mine.companyId,
      kind: "CUSTOMER",
    });
    expect(listed.total).toBe(0);
    expect(listed.rows).toHaveLength(0);
  });

  it("cannot edit a record through another company's context", async () => {
    const [mine, theirs] = await Promise.all([
      createCompany("Isolation C"),
      createCompany("Isolation D"),
    ]);

    const theirCustomer = await createParty({
      ...actor(theirs),
      kind: "CUSTOMER",
      input: customerInput({ name: "Their Customer" }),
    });

    // The id is real and the caller is authenticated — the company scope is
    // the only thing standing between them, which is exactly the case that
    // must not be allowed to pass.
    await expect(
      updateParty({
        ...actor(mine),
        kind: "CUSTOMER",
        partyId: theirCustomer.id,
        input: customerInput({ name: "Hijacked" }),
      }),
    ).rejects.toThrow(/could not be found/);

    const unchanged = await prisma.customer.findUniqueOrThrow({
      where: { id: theirCustomer.id },
      select: { name: true },
    });
    expect(unchanged.name).toBe("Their Customer");
  });

  it("cannot archive another company's product", async () => {
    const [mine, theirs] = await Promise.all([
      createCompany("Isolation E"),
      createCompany("Isolation F"),
    ]);
    const unitId = await firstUnitId(theirs.companyId);
    const theirProduct = await createProduct({
      ...actor(theirs),
      input: productInput(unitId),
    });

    await expect(
      setProductArchived({
        companyId: mine.companyId,
        productId: theirProduct.id,
        archived: true,
        userId: mine.userId,
        actorEmail: "owner@example.com",
      }),
    ).rejects.toThrow(/could not be found/);
  });

  it("lets two companies use the same product code", async () => {
    const [mine, theirs] = await Promise.all([
      createCompany("Isolation G"),
      createCompany("Isolation H"),
    ]);

    const [mineUnit, theirsUnit] = await Promise.all([
      firstUnitId(mine.companyId),
      firstUnitId(theirs.companyId),
    ]);

    await createProduct({ ...actor(mine), input: productInput(mineUnit) });
    // Uniqueness is composite with companyId, so the same SKU in a different
    // tenant is not a conflict.
    await expect(
      createProduct({ ...actor(theirs), input: productInput(theirsUnit) }),
    ).resolves.toBeDefined();
  });
});

describe("archiving", () => {
  it("hides an archived customer from the default list but keeps the ledger", async () => {
    const company = await createCompany();
    const created = await createParty({
      ...actor(company),
      kind: "CUSTOMER",
      input: customerInput({ openingBalance: 50000 }),
    });

    await setPartyArchived({
      ...actor(company),
      kind: "CUSTOMER",
      partyId: created.id,
      archived: true,
    });

    const visible = await listParties({
      companyId: company.companyId,
      kind: "CUSTOMER",
    });
    expect(visible.total).toBe(0);

    const withArchived = await listParties({
      companyId: company.companyId,
      kind: "CUSTOMER",
      includeArchived: true,
    });
    expect(withArchived.total).toBe(1);
    expect(withArchived.rows[0]?.isArchived).toBe(true);

    // The point of archiving rather than deleting: the entry still exists.
    expect(
      await accountBalance(
        company.companyId,
        SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
      ),
    ).toBe(toStorageString(50000));
  });

  it("restores an archived product", async () => {
    const company = await createCompany();
    const unitId = await firstUnitId(company.companyId);
    const created = await createProduct({
      ...actor(company),
      input: productInput(unitId),
    });

    await setProductArchived({
      ...actor(company),
      productId: created.id,
      archived: true,
    });
    await setProductArchived({
      ...actor(company),
      productId: created.id,
      archived: false,
    });

    const listed = await listProducts({ companyId: company.companyId });
    expect(listed.total).toBe(1);
    expect(listed.rows[0]?.isArchived).toBe(false);
  });
});

describe("units and categories", () => {
  it("provisions a starting set of units and GST slabs", async () => {
    const company = await createCompany();
    const taxonomy = await getProductTaxonomy(company.companyId);
    expect(taxonomy.units.length).toBeGreaterThan(0);
    expect(taxonomy.taxRates.length).toBeGreaterThan(0);
  });

  it("fixes a unit's precision once products use it", async () => {
    const company = await createCompany();
    const unit = await createUnit({
      ...actor(company),
      input: { code: "TIN", name: "Tin", precision: 0 },
    });

    const beforeUse = await updateUnit({
      ...actor(company),
      unitId: unit.id,
      input: { code: "TIN", name: "Tin can", precision: 2 },
    });
    expect(beforeUse.precisionLocked).toBe(false);

    await createProduct({
      ...actor(company),
      input: productInput(unit.id, { sku: "OIL-TIN" }),
    });

    const afterUse = await updateUnit({
      ...actor(company),
      unitId: unit.id,
      input: { code: "TIN", name: "Tin", precision: 3 },
    });
    expect(afterUse.precisionLocked).toBe(true);

    const stored = await prisma.unit.findUniqueOrThrow({
      where: { id: unit.id },
      select: { precision: true, name: true },
    });
    // The rename went through; the precision did not.
    expect(stored.precision).toBe(2);
    expect(stored.name).toBe("Tin");
  });

  it("counts products against their category", async () => {
    const company = await createCompany();
    const unitId = await firstUnitId(company.companyId);
    const category = await createCategory({
      ...actor(company),
      input: { name: "Staples", parentId: "", description: "" },
    });

    await createProduct({
      ...actor(company),
      input: productInput(unitId, { categoryId: category.id }),
    });

    const taxonomy = await getProductTaxonomy(company.companyId);
    expect(
      taxonomy.categories.find((entry) => entry.id === category.id)
        ?.productCount,
    ).toBe(1);
  });
});

describe("employees", () => {
  it("posts nothing to the ledger when staff are added", async () => {
    const company = await createCompany();
    const before = await prisma.journalEntry.count({
      where: { companyId: company.companyId },
    });

    await createEmployee({ ...actor(company), input: employeeInput() });

    expect(
      await prisma.journalEntry.count({
        where: { companyId: company.companyId },
      }),
    ).toBe(before);
  });

  it("totals only current staff in the payroll commitment", async () => {
    const company = await createCompany();
    await createEmployee({ ...actor(company), input: employeeInput() });
    const leaver = await createEmployee({
      ...actor(company),
      input: employeeInput({
        name: "Priya Nair",
        basicSalary: 18000,
        allowances: 2500,
      }),
    });

    const before = await listEmployees({ companyId: company.companyId });
    expect(before.activeMonthlyCost).toBe(toStorageString(52500));

    await updateEmployee({
      ...actor(company),
      employeeId: leaver.id,
      input: employeeInput({
        name: "Priya Nair",
        basicSalary: 18000,
        allowances: 2500,
        status: "RESIGNED",
        exitDate: "2026-03-31",
      }),
    });

    const after = await listEmployees({ companyId: company.companyId });
    expect(after.activeMonthlyCost).toBe(toStorageString(32000));
    // A former employee drops out of the default list but is still on file.
    expect(after.total).toBe(1);
    expect(
      (
        await listEmployees({
          companyId: company.companyId,
          includeFormer: true,
        })
      ).total,
    ).toBe(2);
  });
});

describe("audit trail", () => {
  it("records what was created, with the opening entry it posted", async () => {
    const company = await createCompany();
    const created = await createParty({
      ...actor(company),
      kind: "CUSTOMER",
      input: customerInput({ openingBalance: 50000 }),
    });

    const log = await prisma.auditLog.findFirst({
      where: {
        companyId: company.companyId,
        entityType: "Customer",
        entityId: created.id,
      },
      select: { action: true, metadata: true },
    });

    expect(log?.action).toBe("party.created");
    const metadata = log?.metadata as Record<string, unknown> | null;
    expect(metadata?.openingEntry).toBe(created.openingEntry);
    expect(metadata?.openingNature).toBe(AccountNature.DEBIT);
  });

  it("marks an opening-balance change apart from an ordinary edit", async () => {
    const company = await createCompany();
    const created = await createParty({
      ...actor(company),
      kind: "CUSTOMER",
      input: customerInput({ openingBalance: 50000 }),
    });

    await updateParty({
      ...actor(company),
      kind: "CUSTOMER",
      partyId: created.id,
      input: customerInput({ openingBalance: 50000, city: "Bengaluru" }),
    });
    await updateParty({
      ...actor(company),
      kind: "CUSTOMER",
      partyId: created.id,
      input: customerInput({ openingBalance: 75000 }),
    });

    const actions = await prisma.auditLog.findMany({
      where: {
        companyId: company.companyId,
        entityType: "Customer",
        entityId: created.id,
      },
      select: { action: true },
      orderBy: { createdAt: "asc" },
    });

    expect(actions.map((entry) => entry.action)).toEqual([
      "party.created",
      "party.updated",
      "party.opening_adjusted",
    ]);
  });
});
