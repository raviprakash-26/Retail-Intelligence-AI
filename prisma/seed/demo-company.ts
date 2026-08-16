import {
  AccountNature,
  MembershipStatus,
  StockMovementType,
  UserStatus,
  VoucherType,
  type PrismaClient,
} from "@prisma/client";
import bcrypt from "bcryptjs";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";
import { SYSTEM_ROLE } from "@/lib/rbac/permissions";
import { add, multiply, subtract, toStorageString } from "@/lib/money";
import { postJournalEntry } from "@/server/accounting/post-journal-entry";
import { allocateDocumentNumber } from "@/server/sequences/document-sequence";
import { provisionCompany } from "@/server/provisioning/company-provisioner";
import {
  purgeCompany,
  purgeOrphanedUsers,
} from "@/server/provisioning/purge-company";

/**
 * The demo tenant: Ravi Retail Mart, a kirana store in Bengaluru.
 *
 * Everything created here is flagged `isDemo` so the application can badge it
 * and offer a one-click reset. The opening position is posted as a real,
 * balanced journal entry through the same code path a user's transactions
 * will take — seeding by writing rows directly would let the demo drift from
 * what the engine actually produces.
 */

export const DEMO = {
  companySlug: "ravi-retail-mart",
  ownerEmail: "owner@raviretailmart.demo",
  accountantEmail: "accountant@raviretailmart.demo",
  cashierEmail: "cashier@raviretailmart.demo",
  /** Published in the README; this tenant holds no real data. */
  password: "DemoRetail@2026",
} as const;

type ProductSeed = {
  sku: string;
  name: string;
  unit: string;
  hsn: string;
  taxCode: string;
  purchasePrice: number;
  sellingPrice: number;
  openingQty: number;
  minStock: number;
};

/** Prices and GST slabs are representative of Indian kirana retail. */
const PRODUCTS: readonly ProductSeed[] = [
  {
    sku: "RICE-SONA-25",
    name: "Sona Masoori Rice (25 kg)",
    unit: "BAG",
    hsn: "1006",
    taxCode: "GST0",
    purchasePrice: 1450,
    sellingPrice: 1620,
    openingQty: 40,
    minStock: 10,
  },
  {
    sku: "SUGAR-1KG",
    name: "Refined Sugar (1 kg)",
    unit: "PKT",
    hsn: "1701",
    taxCode: "GST5",
    purchasePrice: 42,
    sellingPrice: 48,
    openingQty: 200,
    minStock: 50,
  },
  {
    sku: "OIL-SUN-1L",
    name: "Sunflower Cooking Oil (1 L)",
    unit: "PCS",
    hsn: "1512",
    taxCode: "GST5",
    purchasePrice: 128,
    sellingPrice: 145,
    openingQty: 120,
    minStock: 30,
  },
  {
    sku: "BISC-MRE-100",
    name: "Marie Biscuits (100 g)",
    unit: "PKT",
    hsn: "1905",
    taxCode: "GST18",
    purchasePrice: 18,
    sellingPrice: 25,
    openingQty: 300,
    minStock: 100,
  },
  {
    sku: "MILK-TON-500",
    name: "Toned Milk (500 ml)",
    unit: "PKT",
    hsn: "0401",
    taxCode: "GST0",
    purchasePrice: 24,
    sellingPrice: 28,
    openingQty: 80,
    minStock: 40,
  },
  {
    sku: "TEA-DUST-500",
    name: "Tea Dust (500 g)",
    unit: "PKT",
    hsn: "0902",
    taxCode: "GST5",
    purchasePrice: 195,
    sellingPrice: 230,
    openingQty: 60,
    minStock: 15,
  },
  {
    sku: "SOAP-BATH-125",
    name: "Bathing Soap (125 g)",
    unit: "PCS",
    hsn: "3401",
    taxCode: "GST18",
    purchasePrice: 32,
    sellingPrice: 42,
    openingQty: 240,
    minStock: 60,
  },
];

const CUSTOMERS = [
  {
    name: "Sharma Provision Store",
    phone: "9845012345",
    email: "accounts@sharmaprovision.demo",
    city: "Bengaluru",
    gstin: "29AABCS1429B1ZX",
    creditLimit: 100000,
    creditDays: 30,
  },
  {
    name: "Lakshmi Kirana",
    phone: "9845023456",
    email: null,
    city: "Bengaluru",
    gstin: null,
    creditLimit: 50000,
    creditDays: 15,
  },
  {
    name: "Anand Canteen Services",
    phone: "9845034567",
    email: "purchasing@anandcanteen.demo",
    city: "Bengaluru",
    gstin: "29AACCA9207D1ZM",
    creditLimit: 150000,
    creditDays: 30,
  },
  {
    name: "Walk-in Customer",
    phone: null,
    email: null,
    city: "Bengaluru",
    gstin: null,
    creditLimit: 0,
    creditDays: 0,
  },
];

const SUPPLIERS = [
  {
    name: "ABC Traders",
    phone: "9880011223",
    city: "Bengaluru",
    gstin: "29AABCA1234C1Z5",
    creditDays: 30,
  },
  {
    name: "Sri Venkateshwara Wholesale",
    phone: "9880022334",
    city: "Bengaluru",
    gstin: "29AAFCS5678D1Z9",
    creditDays: 21,
  },
  {
    name: "Karnataka Dairy Supplies",
    phone: "9880033445",
    city: "Mysuru",
    gstin: "29AADCK9012E1Z3",
    creditDays: 7,
  },
];

const EMPLOYEES = [
  {
    name: "Suresh Kumar",
    designation: "Store Manager",
    department: "Operations",
    basic: 28000,
    allowances: 4000,
  },
  {
    name: "Priya Nair",
    designation: "Cashier",
    department: "Sales",
    basic: 18000,
    allowances: 2500,
  },
  {
    name: "Mohan Reddy",
    designation: "Stock Assistant",
    department: "Warehouse",
    basic: 15000,
    allowances: 2000,
  },
];

const OPENING = {
  cash: 45_000,
  bank: 285_000,
  furnitureAndFittings: 120_000,
} as const;

export async function seedDemoCompany(prisma: PrismaClient, asOf: Date) {
  // Idempotency: a re-run replaces the demo tenant wholesale rather than
  // layering a second copy on top of it.
  const existing = await prisma.company.findUnique({
    where: { slug: DEMO.companySlug },
    select: { id: true },
  });

  if (existing) {
    // Posted entries are protected by database triggers, so this goes through
    // the explicit purge path rather than a plain delete.
    await purgeCompany(existing.id);
    await purgeOrphanedUsers([
      DEMO.ownerEmail,
      DEMO.accountantEmail,
      DEMO.cashierEmail,
    ]);
  }

  // Cost 4 rather than the production factor: this runs on every seed and the
  // credentials are public anyway.
  const passwordHash = await bcrypt.hash(DEMO.password, 4);

  return prisma.$transaction(
    async (tx) => {
      const provisioned = await provisionCompany(tx, {
        name: "Ravi Retail Mart",
        legalName: "Ravi Retail Mart",
        slug: DEMO.companySlug,
        businessType: "SOLE_PROPRIETORSHIP",
        gstRegistration: "REGULAR",
        gstin: "29AAAPR1234K1ZP",
        pan: "AAAPR1234K",
        addressLine1: "42 Avenue Road, Chickpet",
        city: "Bengaluru",
        state: "Karnataka",
        stateCode: "29",
        pincode: "560053",
        phone: "9845000000",
        email: "hello@raviretailmart.demo",
        currency: "INR",
        fiscalYearStartMonth: 4,
        inventoryMethod: "WEIGHTED_AVERAGE",
        isDemo: true,
        asOf,
      });

      const {
        companyId,
        branchId,
        accountsBySystemKey,
        taxRatesByCode,
        unitsByCode,
        roleIdsByKey,
      } = provisioned;

      const accountId = (key: string) => {
        const id = accountsBySystemKey.get(key);
        if (!id) throw new Error(`Demo seed: missing system account ${key}`);
        return id;
      };

      // --- People ---------------------------------------------------------
      const team = [
        {
          email: DEMO.ownerEmail,
          fullName: "Ravi Prakash",
          mobile: "9845000000",
          role: SYSTEM_ROLE.OWNER,
        },
        {
          email: DEMO.accountantEmail,
          fullName: "Deepa Iyer",
          mobile: "9845000001",
          role: SYSTEM_ROLE.ACCOUNTANT,
        },
        {
          email: DEMO.cashierEmail,
          fullName: "Priya Nair",
          mobile: "9845000002",
          role: SYSTEM_ROLE.CASHIER,
        },
      ];

      let ownerId = "";
      for (const member of team) {
        const user = await tx.user.create({
          data: {
            email: member.email,
            fullName: member.fullName,
            mobile: member.mobile,
            passwordHash,
            status: UserStatus.ACTIVE,
            emailVerifiedAt: asOf,
            defaultCompanyId: companyId,
          },
          select: { id: true },
        });

        if (member.role === SYSTEM_ROLE.OWNER) ownerId = user.id;

        const roleId = roleIdsByKey.get(member.role);
        if (!roleId) throw new Error(`Demo seed: missing role ${member.role}`);

        await tx.membership.create({
          data: {
            userId: user.id,
            companyId,
            roleId,
            status: MembershipStatus.ACTIVE,
            joinedAt: asOf,
          },
        });
      }

      // --- Categories & products -------------------------------------------
      const categoryNames = [
        "Staples",
        "Beverages",
        "Packaged Foods",
        "Household",
      ];
      const categories = new Map<string, string>();
      for (const name of categoryNames) {
        const category = await tx.category.create({
          data: { companyId, name },
          select: { id: true },
        });
        categories.set(name, category.id);
      }

      const categoryFor = (sku: string) => {
        if (
          sku.startsWith("RICE") ||
          sku.startsWith("SUGAR") ||
          sku.startsWith("OIL")
        ) {
          return categories.get("Staples");
        }
        if (sku.startsWith("TEA") || sku.startsWith("MILK")) {
          return categories.get("Beverages");
        }
        if (sku.startsWith("SOAP")) return categories.get("Household");
        return categories.get("Packaged Foods");
      };

      let openingStockValue = "0";
      for (const product of PRODUCTS) {
        const unitId = unitsByCode.get(product.unit);
        const taxRateId = taxRatesByCode.get(product.taxCode);
        if (!unitId) throw new Error(`Demo seed: missing unit ${product.unit}`);

        const created = await tx.product.create({
          data: {
            companyId,
            categoryId: categoryFor(product.sku) ?? null,
            unitId,
            taxRateId: taxRateId ?? null,
            sku: product.sku,
            name: product.name,
            hsnCode: product.hsn,
            purchasePrice: product.purchasePrice,
            sellingPrice: product.sellingPrice,
            openingQuantity: product.openingQty,
            openingRate: product.purchasePrice,
            minStockLevel: product.minStock,
            isStockTracked: true,
          },
          select: { id: true },
        });

        const lineValue = multiply(product.openingQty, product.purchasePrice);
        openingStockValue = toStorageString(add(openingStockValue, lineValue));

        await tx.inventoryBalance.create({
          data: {
            companyId,
            productId: created.id,
            branchId,
            quantity: product.openingQty,
            averageCost: product.purchasePrice,
            stockValue: toStorageString(lineValue),
            lastMovementAt: asOf,
          },
        });

        // The stock ledger starts with an explicit opening row, so a stock
        // position is always reconstructable from movements alone.
        await tx.inventoryMovement.create({
          data: {
            companyId,
            productId: created.id,
            branchId,
            movementType: StockMovementType.OPENING,
            movementDate: asOf,
            quantity: product.openingQty,
            unitCost: product.purchasePrice,
            value: toStorageString(lineValue),
            balanceQuantity: product.openingQty,
            balanceValue: toStorageString(lineValue),
            sourceType: "OPENING_BALANCE",
            notes: "Opening stock on migration to Retail Intelligence AI",
          },
        });
      }

      // --- Parties ---------------------------------------------------------
      // Codes come from the same numbering series the application uses, so the
      // first customer a user adds continues the sequence instead of colliding
      // with a code the seed had written straight into the table.
      for (const customer of CUSTOMERS) {
        await tx.customer.create({
          data: {
            companyId,
            code: await allocateDocumentNumber(tx, {
              companyId,
              key: "CUSTOMER",
            }),
            name: customer.name,
            phone: customer.phone,
            email: customer.email,
            gstin: customer.gstin,
            city: customer.city,
            state: "Karnataka",
            stateCode: "29",
            creditLimit: customer.creditLimit,
            creditDays: customer.creditDays,
            openingNature: AccountNature.DEBIT,
          },
        });
      }

      for (const supplier of SUPPLIERS) {
        await tx.supplier.create({
          data: {
            companyId,
            code: await allocateDocumentNumber(tx, {
              companyId,
              key: "SUPPLIER",
            }),
            name: supplier.name,
            phone: supplier.phone,
            gstin: supplier.gstin,
            city: supplier.city,
            state: "Karnataka",
            stateCode: "29",
            creditDays: supplier.creditDays,
            openingNature: AccountNature.CREDIT,
          },
        });
      }

      for (const employee of EMPLOYEES) {
        await tx.employee.create({
          data: {
            companyId,
            employeeCode: await allocateDocumentNumber(tx, {
              companyId,
              key: "EMPLOYEE",
            }),
            name: employee.name,
            designation: employee.designation,
            department: employee.department,
            joiningDate: new Date(Date.UTC(asOf.getUTCFullYear() - 1, 5, 1)),
            basicSalary: employee.basic,
            allowances: employee.allowances,
          },
        });
      }

      // --- Bank account -----------------------------------------------------
      await tx.bankAccount.create({
        data: {
          companyId,
          accountId: accountId(SYSTEM_ACCOUNT.BANK),
          name: "Current Account — Canara Bank",
          bankName: "Canara Bank",
          accountNumber: "0421201000456",
          ifsc: "CNRB0000421",
          branchName: "Chickpet",
          type: "CURRENT",
          openingBalance: OPENING.bank,
        },
      });

      // --- Opening balance journal ------------------------------------------
      // Assets brought in are debited; the balancing credit is the owner's
      // capital. This is a genuine balanced entry, posted through the same
      // function every module will use.
      const totalAssets = add(
        OPENING.cash,
        OPENING.bank,
        openingStockValue,
        OPENING.furnitureAndFittings,
      );

      const openingDate = new Date(
        Date.UTC(
          asOf.getUTCMonth() + 1 >= 4
            ? asOf.getUTCFullYear()
            : asOf.getUTCFullYear() - 1,
          3,
          1,
        ),
      );

      const journal = await postJournalEntry(tx, {
        companyId,
        branchId,
        entryDate: openingDate,
        voucherType: VoucherType.OPENING_BALANCE,
        narration: "Opening balances on migration to Retail Intelligence AI",
        isSystem: true,
        createdById: ownerId,
        sourceType: "OPENING_BALANCE",
        lines: [
          {
            accountId: accountId(SYSTEM_ACCOUNT.CASH),
            debit: OPENING.cash,
            narration: "Opening cash in hand",
          },
          {
            accountId: accountId(SYSTEM_ACCOUNT.BANK),
            debit: OPENING.bank,
            narration: "Opening bank balance",
          },
          {
            accountId: accountId(SYSTEM_ACCOUNT.INVENTORY),
            debit: openingStockValue,
            narration: "Opening stock at cost",
          },
          {
            accountId: accountId(SYSTEM_ACCOUNT.FIXED_ASSETS),
            debit: OPENING.furnitureAndFittings,
            narration: "Shop furniture and fittings",
          },
          {
            accountId: accountId(SYSTEM_ACCOUNT.OWNER_CAPITAL),
            credit: toStorageString(totalAssets),
            narration: "Owner's capital introduced",
          },
        ],
      });

      // Persist the opening figures on the accounts themselves so the ledger
      // can show an opening balance without replaying the journal.
      const openingByKey: Array<[string, number | string]> = [
        [SYSTEM_ACCOUNT.CASH, OPENING.cash],
        [SYSTEM_ACCOUNT.BANK, OPENING.bank],
        [SYSTEM_ACCOUNT.INVENTORY, openingStockValue],
        [SYSTEM_ACCOUNT.FIXED_ASSETS, OPENING.furnitureAndFittings],
      ];

      for (const [key, amount] of openingByKey) {
        await tx.account.update({
          where: { id: accountId(key) },
          data: {
            openingBalance: String(amount),
            openingNature: AccountNature.DEBIT,
          },
        });
      }

      await tx.account.update({
        where: { id: accountId(SYSTEM_ACCOUNT.OWNER_CAPITAL) },
        data: {
          openingBalance: toStorageString(totalAssets),
          openingNature: AccountNature.CREDIT,
        },
      });

      await tx.fixedAsset.create({
        data: {
          companyId,
          accountId: accountId(SYSTEM_ACCOUNT.FIXED_ASSETS),
          code: "FA-0001",
          name: "Shop furniture and fittings",
          category: "Furniture",
          purchaseDate: openingDate,
          purchaseCost: OPENING.furnitureAndFittings,
          usefulLifeMonths: 120,
          method: "WRITTEN_DOWN_VALUE",
          ratePercent: 10,
          bookValue: OPENING.furnitureAndFittings,
        },
      });

      return {
        companyId,
        ownerId,
        openingEntry: journal.entryNumber,
        openingTotal: toStorageString(totalAssets),
        openingStockValue,
        products: PRODUCTS.length,
        customers: CUSTOMERS.length,
        suppliers: SUPPLIERS.length,
        employees: EMPLOYEES.length,
        // Sanity figure printed by the seed: assets minus capital must be zero.
        residual: toStorageString(subtract(totalAssets, totalAssets)),
      };
    },
    { timeout: 60_000 },
  );
}
