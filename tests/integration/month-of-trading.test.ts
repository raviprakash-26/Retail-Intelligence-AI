import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JournalStatus } from "@prisma/client";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import { money, subtract, toStorageString } from "@/lib/money";
import type { RegisterInput } from "@/lib/validation/auth";
import type {
  CustomerInput,
  ProductInput,
  SupplierInput,
} from "@/lib/validation/master-data";
import { registerOwner } from "@/server/auth/registration";
import { createParty } from "@/server/master-data/party-service";
import { createProduct } from "@/server/master-data/product-service";
import { getProductTaxonomy } from "@/server/master-data/taxonomy-service";
import { createPurchase } from "@/server/purchases/purchase-service";
import { createSale } from "@/server/sales/sale-service";
import { createExpense } from "@/server/expenses/expense-service";
import {
  createReceipt,
  createPayment,
} from "@/server/settlements/settlement-service";
import {
  createSalesReturn,
  returnableLines,
} from "@/server/returns/sales-return-service";
import { getTrialBalance } from "@/server/accounting/trial-balance-service";
import {
  receivablesAgeing,
  payablesAgeing,
  openInvoices,
} from "@/server/settlements/outstanding";
import { getStockSummary } from "@/server/inventory/inventory-report";
import { getGstWorkingPaper } from "@/server/gst/gst-return-service";
import { closePeriod } from "@/server/accounting/period-service";
import { voidExpense } from "@/server/expenses/expense-service";
import { PeriodClosedError } from "@/server/accounting/post-journal-entry";
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
const today = new Date().toISOString().slice(0, 10);
const now = new Date();

function registrationInput(email: string): RegisterInput {
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
      businessName: `Scenario ${uniqueSlug("Mart")}`,
      businessType: "SOLE_PROPRIETORSHIP",
      gstRegistration: "REGULAR",
      gstin: "29AAAPR1234K1ZP",
      pan: "AAAPR1234K",
      addressLine1: "42 Avenue Road",
      city: "Bengaluru",
      stateCode: "29",
      pincode: "560053",
    },
    accounting: {
      fiscalYearStartMonth: 4,
      currency: "INR",
      openingCashBalance: 200_000,
      openingBankBalance: 100_000,
      inventoryMethod: "WEIGHTED_AVERAGE",
      loadDemoData: false,
    },
  };
}

beforeAll(async () => {
  await ensurePlatformData();
}, 60_000);
afterAll(async () => {
  for (const id of createdCompanies) await purgeTestCompany(id);
  await purgeTestUsers(createdEmails);
  await disconnectTestDb();
}, 120_000);

/** Net debit on a system account across every posted line. */
async function accountNet(companyId: string, systemKey: string) {
  const account = await prisma.account.findFirst({
    where: { companyId, systemKey },
    select: { id: true },
  });
  if (!account) return money(0);
  const sums = await prisma.journalLine.aggregate({
    where: { companyId, accountId: account.id, status: JournalStatus.POSTED },
    _sum: { debit: true, credit: true },
  });
  return subtract(sums._sum.debit ?? 0, sums._sum.credit ?? 0);
}

describe("a month of trading, read every way the product offers", () => {
  it("leaves every reader of every fact agreeing with every other", async () => {
    const email = `scenario-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
    createdEmails.push(email);
    const owner = await registerOwner(registrationInput(email));
    createdCompanies.push(owner.companyId);
    const base = {
      companyId: owner.companyId,
      userId: owner.userId,
      actorEmail: email,
    };

    const taxonomy = await getProductTaxonomy(owner.companyId);
    const unit = taxonomy.units.find((u) => u.code === "PCS")!;
    const rate = taxonomy.taxRates.find((r) => Number(r.ratePercent) === 18)!;

    const product = await createProduct({
      ...base,
      input: {
        sku: "RICE",
        name: "Sona Masoori",
        description: "",
        barcode: "",
        hsnCode: "1006",
        categoryId: "",
        unitId: unit.id,
        taxRateId: rate.id,
        purchasePrice: 50,
        sellingPrice: 80,
        mrp: 0,
        isStockTracked: true,
        openingQuantity: 100,
        openingRate: 50,
        minStockLevel: 0,
      } satisfies ProductInput,
    });

    const customer = await createParty({
      ...base,
      kind: "CUSTOMER",
      input: {
        name: "Sharma Provision Store",
        phone: "",
        email: "",
        gstin: "",
        pan: "",
        addressLine1: "",
        city: "",
        stateCode: "29",
        pincode: "",
        creditDays: 30,
        creditLimit: 10_000_000,
        openingBalance: 0,
        openingNature: "DEBIT",
        notes: "",
      } satisfies CustomerInput,
    });

    const supplier = await createParty({
      ...base,
      kind: "SUPPLIER",
      input: {
        name: "Karnataka Wholesalers",
        phone: "",
        email: "",
        gstin: "",
        pan: "",
        addressLine1: "",
        city: "",
        stateCode: "29",
        pincode: "",
        creditDays: 30,
        openingBalance: 0,
        openingNature: "CREDIT",
        notes: "",
      } satisfies SupplierInput,
    });

    // --- A month of trading ------------------------------------------------
    await createPurchase({
      ...base,
      branchId: null,
      input: {
        supplierId: supplier.id,
        supplierBillNo: "KW-1",
        billDate: today,
        paymentMode: "CREDIT",
        priceIncludesTax: false,
        claimInputCredit: true,
        notes: "",
        lines: [
          {
            productId: product.id,
            description: "",
            quantity: 200,
            rate: 55,
            discountPercent: 0,
          },
        ],
      },
    });

    const sale = await createSale({
      ...base,
      branchId: null,
      input: {
        customerId: customer.id,
        invoiceDate: today,
        paymentMode: "CREDIT",
        placeOfSupply: "",
        priceIncludesTax: false,
        notes: "",
        lines: [
          {
            productId: product.id,
            description: "",
            quantity: 120,
            rate: 80,
            discountPercent: 0,
          },
        ],
      },
    });

    const rent = await createExpense({
      ...base,
      branchId: null,
      input: {
        categoryId: (
          await prisma.expenseCategory.findFirstOrThrow({
            where: { companyId: owner.companyId },
            select: { id: true },
          })
        ).id,
        expenseDate: today,
        paymentMode: "CASH",
        supplierId: "",
        payeeName: "Landlord",
        amount: 12_000,
        taxPercent: 0,
        amountIncludesTax: true,
        claimInputCredit: false,
        isCapitalExpenditure: false,
        assetName: "",
        assetUsefulLifeMonths: 60,
        referenceNo: "",
        notes: "",
      },
    });

    await createReceipt({
      ...base,
      input: {
        kind: "CUSTOMER",
        partyId: customer.id,
        date: today,
        amount: 5_000,
        paymentMode: "CASH",
        referenceNo: "",
        notes: "",
        allocations: [],
      },
    });

    await createPayment({
      ...base,
      input: {
        kind: "SUPPLIER",
        partyId: supplier.id,
        date: today,
        amount: 4_000,
        paymentMode: "BANK",
        referenceNo: "",
        notes: "",
        allocations: [],
      },
    });

    const lines = await returnableLines({
      companyId: owner.companyId,
      saleId: sale.id,
    });
    await createSalesReturn({
      ...base,
      branchId: null,
      input: {
        saleId: sale.id,
        returnDate: today,
        reason: "Damaged sack",
        refundMode: "CREDIT",
        lines: [{ sourceLineId: lines[0]!.lineId, quantity: 10 }],
      },
    });

    // --- Now: does every reader agree with every other? --------------------
    const trial = await getTrialBalance({
      companyId: owner.companyId,
      to: today,
    });
    expect(trial.balanced).toBe(true);

    // Receivables, read two ways.
    //
    // The ageing *total* is not the interesting comparison: `withLedgerResidual`
    // works out the residual as the difference between the control account and
    // the documents, so the two agree by construction and a defect in what a
    // credit note takes off an invoice would be absorbed into the residual
    // rather than shown. Checked here first because it is what the README
    // promises, and then the document-level figure, which is the one that can
    // actually disagree.
    const arControl = await accountNet(
      owner.companyId,
      SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
    );
    const ageing = await receivablesAgeing(owner.companyId);
    expect(toStorageString(ageing.summary.total)).toBe(
      toStorageString(arControl),
    );

    // What the invoice itself still owes, against arithmetic rather than
    // against the ledger.
    //
    // Reconciling the documents to the control account cannot be the check:
    // `withLedgerResidual` and `unappliedCredit` are both *defined* as the gap
    // between the two, so either comparison closes itself and would pass with
    // credit notes taking nothing off an invoice at all. Only a figure worked
    // out from the documents can disagree.
    //
    // 120 sacks at ₹80 is ₹9,600, ₹11,328 with tax. Ten came back: ₹800, ₹944
    // with tax. The ₹5,000 receipt named no invoice, so it reduces none of it.
    const open = await openInvoices(prisma, {
      companyId: owner.companyId,
      customerId: customer.id,
    });
    expect(open).toHaveLength(1);
    expect(open[0]!.outstanding).toBe("10384.0000");

    // Payables: the same question on the other side.
    const apControl = await accountNet(
      owner.companyId,
      SYSTEM_ACCOUNT.ACCOUNTS_PAYABLE,
    );
    const payables = await payablesAgeing(owner.companyId);
    expect(toStorageString(payables.summary.total)).toBe(
      toStorageString(apControl.negated()),
    );

    // Inventory: the account, and the stock ledger it is supposed to mirror.
    const inventoryAccount = await accountNet(
      owner.companyId,
      SYSTEM_ACCOUNT.INVENTORY,
    );
    const stock = await getStockSummary({ companyId: owner.companyId });
    expect(toStorageString(money(stock.totalValue))).toBe(
      toStorageString(inventoryAccount),
    );

    // GST: the register the return is built from, and the accounts behind it.
    const paper = await getGstWorkingPaper({
      companyId: owner.companyId,
      year: now.getUTCFullYear(),
      month: now.getUTCMonth() + 1,
    });
    expect(paper.reconciliation.agrees).toBe(true);

    // --- Close the month, then keep trading -------------------------------
    const period = await prisma.fiscalPeriod.findFirstOrThrow({
      where: {
        companyId: owner.companyId,
        startDate: { lte: new Date(`${today}T00:00:00.000Z`) },
        endDate: { gte: new Date(`${today}T00:00:00.000Z`) },
      },
      select: { id: true, startDate: true },
    });
    // Everything before it has to be shut first, in order.
    const earlier = await prisma.fiscalPeriod.findMany({
      where: {
        companyId: owner.companyId,
        startDate: { lt: period.startDate },
      },
      select: { id: true },
      orderBy: { startDate: "asc" },
    });
    for (const p of [...earlier, period]) {
      await closePeriod({ ...base, periodId: p.id, note: "Month end" });
    }

    // A void reverses into the original document's period, so it must now be
    // refused rather than quietly reopening a closed month.
    //
    // The rent, and the reason is asserted. The invoice has a credit note
    // against it and the bill's stock has partly been sold, so voiding either
    // is refused for its own reason whatever the period says — checks that
    // would have passed here without the close having anything to do with it.
    // The expense has neither obstacle, so only the closed period can refuse.
    await expect(
      voidExpense({
        companyId: owner.companyId,
        expenseId: rent.id,
        userId: owner.userId,
        actorEmail: email,
        reason: "Testing the closed period",
      }),
    ).rejects.toThrow(PeriodClosedError);

    // And the books are exactly as they were: a refused void posts nothing.
    const afterRefusal = await getTrialBalance({
      companyId: owner.companyId,
      to: today,
    });
    expect(afterRefusal.balanced).toBe(true);
    expect(
      toStorageString(
        await accountNet(owner.companyId, SYSTEM_ACCOUNT.INVENTORY),
      ),
    ).toBe(toStorageString(inventoryAccount));

    // The closed month's return still reconciles — closing freezes it, and a
    // frozen figure that stopped agreeing with its own ledger would be worse
    // than one that could still move.
    const frozen = await getGstWorkingPaper({
      companyId: owner.companyId,
      year: now.getUTCFullYear(),
      month: now.getUTCMonth() + 1,
    });
    expect(frozen.reconciliation.agrees).toBe(true);
    expect(frozen.outward.total.totalTax).toBe(paper.outward.total.totalTax);
  }, 300_000);
});
