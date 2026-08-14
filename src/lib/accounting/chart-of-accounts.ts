import {
  AccountNature,
  AccountSubType,
  AccountType,
  PartyType,
  StatementSection,
} from "@prisma/client";
import { SYSTEM_ACCOUNT, type SystemAccountKey } from "./system-accounts";

/**
 * The default chart of accounts every new company is seeded with.
 *
 * Codes follow the conventional numeric blocks so that a retailer's accountant
 * recognises the structure immediately:
 *
 *   1000-1999  Assets
 *   2000-2999  Liabilities
 *   3000-3999  Equity / Capital
 *   4000-4999  Income
 *   5000-5999  Direct costs (Trading Account)
 *   6000-6999  Indirect / operating expenses (Profit & Loss)
 *
 * Tenants may add, rename and renumber accounts. `isSystem` accounts may be
 * renamed but not deleted, because posting rules resolve them by `systemKey`.
 */

export type AccountGroupSeed = {
  code: string;
  name: string;
  type: AccountType;
  nature: AccountNature;
  section: StatementSection;
  sortOrder: number;
  parentCode?: string;
};

export type AccountSeed = {
  code: string;
  name: string;
  groupCode: string;
  type: AccountType;
  subType: AccountSubType;
  nature: AccountNature;
  section: StatementSection;
  systemKey?: SystemAccountKey;
  partyType?: PartyType;
  description?: string;
};

export const DEFAULT_ACCOUNT_GROUPS: readonly AccountGroupSeed[] = [
  // --- Assets ---------------------------------------------------------
  {
    code: "1000",
    name: "Assets",
    type: AccountType.ASSET,
    nature: AccountNature.DEBIT,
    section: StatementSection.BALANCE_SHEET,
    sortOrder: 100,
  },
  {
    code: "1100",
    name: "Current Assets",
    type: AccountType.ASSET,
    nature: AccountNature.DEBIT,
    section: StatementSection.BALANCE_SHEET,
    sortOrder: 110,
    parentCode: "1000",
  },
  {
    code: "1110",
    name: "Cash & Bank",
    type: AccountType.ASSET,
    nature: AccountNature.DEBIT,
    section: StatementSection.BALANCE_SHEET,
    sortOrder: 111,
    parentCode: "1100",
  },
  {
    code: "1120",
    name: "Accounts Receivable",
    type: AccountType.ASSET,
    nature: AccountNature.DEBIT,
    section: StatementSection.BALANCE_SHEET,
    sortOrder: 112,
    parentCode: "1100",
  },
  {
    code: "1130",
    name: "Inventory",
    type: AccountType.ASSET,
    nature: AccountNature.DEBIT,
    section: StatementSection.BALANCE_SHEET,
    sortOrder: 113,
    parentCode: "1100",
  },
  {
    code: "1140",
    name: "Tax Credits",
    type: AccountType.ASSET,
    nature: AccountNature.DEBIT,
    section: StatementSection.BALANCE_SHEET,
    sortOrder: 114,
    parentCode: "1100",
  },
  {
    code: "1150",
    name: "Other Current Assets",
    type: AccountType.ASSET,
    nature: AccountNature.DEBIT,
    section: StatementSection.BALANCE_SHEET,
    sortOrder: 115,
    parentCode: "1100",
  },
  {
    code: "1200",
    name: "Fixed Assets",
    type: AccountType.ASSET,
    nature: AccountNature.DEBIT,
    section: StatementSection.BALANCE_SHEET,
    sortOrder: 120,
    parentCode: "1000",
  },

  // --- Liabilities ----------------------------------------------------
  {
    code: "2000",
    name: "Liabilities",
    type: AccountType.LIABILITY,
    nature: AccountNature.CREDIT,
    section: StatementSection.BALANCE_SHEET,
    sortOrder: 200,
  },
  {
    code: "2100",
    name: "Current Liabilities",
    type: AccountType.LIABILITY,
    nature: AccountNature.CREDIT,
    section: StatementSection.BALANCE_SHEET,
    sortOrder: 210,
    parentCode: "2000",
  },
  {
    code: "2110",
    name: "Accounts Payable",
    type: AccountType.LIABILITY,
    nature: AccountNature.CREDIT,
    section: StatementSection.BALANCE_SHEET,
    sortOrder: 211,
    parentCode: "2100",
  },
  {
    code: "2120",
    name: "Tax Liabilities",
    type: AccountType.LIABILITY,
    nature: AccountNature.CREDIT,
    section: StatementSection.BALANCE_SHEET,
    sortOrder: 212,
    parentCode: "2100",
  },
  {
    code: "2130",
    name: "Accrued Liabilities",
    type: AccountType.LIABILITY,
    nature: AccountNature.CREDIT,
    section: StatementSection.BALANCE_SHEET,
    sortOrder: 213,
    parentCode: "2100",
  },
  {
    code: "2200",
    name: "Long Term Liabilities",
    type: AccountType.LIABILITY,
    nature: AccountNature.CREDIT,
    section: StatementSection.BALANCE_SHEET,
    sortOrder: 220,
    parentCode: "2000",
  },

  // --- Equity ---------------------------------------------------------
  {
    code: "3000",
    name: "Capital & Reserves",
    type: AccountType.EQUITY,
    nature: AccountNature.CREDIT,
    section: StatementSection.BALANCE_SHEET,
    sortOrder: 300,
  },

  // --- Income ---------------------------------------------------------
  {
    code: "4000",
    name: "Income",
    type: AccountType.INCOME,
    nature: AccountNature.CREDIT,
    section: StatementSection.TRADING,
    sortOrder: 400,
  },
  {
    code: "4100",
    name: "Revenue from Operations",
    type: AccountType.INCOME,
    nature: AccountNature.CREDIT,
    section: StatementSection.TRADING,
    sortOrder: 410,
    parentCode: "4000",
  },
  {
    code: "4200",
    name: "Other Income",
    type: AccountType.INCOME,
    nature: AccountNature.CREDIT,
    section: StatementSection.PROFIT_AND_LOSS,
    sortOrder: 420,
    parentCode: "4000",
  },

  // --- Direct costs (Trading Account) ---------------------------------
  {
    code: "5000",
    name: "Cost of Sales",
    type: AccountType.EXPENSE,
    nature: AccountNature.DEBIT,
    section: StatementSection.TRADING,
    sortOrder: 500,
  },

  // --- Indirect expenses (Profit & Loss) ------------------------------
  {
    code: "6000",
    name: "Operating Expenses",
    type: AccountType.EXPENSE,
    nature: AccountNature.DEBIT,
    section: StatementSection.PROFIT_AND_LOSS,
    sortOrder: 600,
  },
  {
    code: "6100",
    name: "Administrative Expenses",
    type: AccountType.EXPENSE,
    nature: AccountNature.DEBIT,
    section: StatementSection.PROFIT_AND_LOSS,
    sortOrder: 610,
    parentCode: "6000",
  },
  {
    code: "6200",
    name: "Selling & Distribution",
    type: AccountType.EXPENSE,
    nature: AccountNature.DEBIT,
    section: StatementSection.PROFIT_AND_LOSS,
    sortOrder: 620,
    parentCode: "6000",
  },
  {
    code: "6300",
    name: "Finance Costs",
    type: AccountType.EXPENSE,
    nature: AccountNature.DEBIT,
    section: StatementSection.PROFIT_AND_LOSS,
    sortOrder: 630,
    parentCode: "6000",
  },
  {
    code: "6400",
    name: "Depreciation & Amortisation",
    type: AccountType.EXPENSE,
    nature: AccountNature.DEBIT,
    section: StatementSection.PROFIT_AND_LOSS,
    sortOrder: 640,
    parentCode: "6000",
  },
] as const;

const asset = (
  code: string,
  name: string,
  groupCode: string,
  subType: AccountSubType,
  systemKey?: SystemAccountKey,
  extra: Partial<AccountSeed> = {},
): AccountSeed => ({
  code,
  name,
  groupCode,
  type: AccountType.ASSET,
  subType,
  nature: AccountNature.DEBIT,
  section: StatementSection.BALANCE_SHEET,
  systemKey,
  ...extra,
});

const liability = (
  code: string,
  name: string,
  groupCode: string,
  subType: AccountSubType,
  systemKey?: SystemAccountKey,
  extra: Partial<AccountSeed> = {},
): AccountSeed => ({
  code,
  name,
  groupCode,
  type: AccountType.LIABILITY,
  subType,
  nature: AccountNature.CREDIT,
  section: StatementSection.BALANCE_SHEET,
  systemKey,
  ...extra,
});

const equity = (
  code: string,
  name: string,
  subType: AccountSubType,
  nature: AccountNature,
  systemKey?: SystemAccountKey,
): AccountSeed => ({
  code,
  name,
  groupCode: "3000",
  type: AccountType.EQUITY,
  subType,
  nature,
  section: StatementSection.BALANCE_SHEET,
  systemKey,
});

const income = (
  code: string,
  name: string,
  groupCode: string,
  subType: AccountSubType,
  section: StatementSection,
  systemKey?: SystemAccountKey,
  nature: AccountNature = AccountNature.CREDIT,
): AccountSeed => ({
  code,
  name,
  groupCode,
  type: AccountType.INCOME,
  subType,
  nature,
  section,
  systemKey,
});

const expense = (
  code: string,
  name: string,
  groupCode: string,
  subType: AccountSubType,
  section: StatementSection,
  systemKey?: SystemAccountKey,
  nature: AccountNature = AccountNature.DEBIT,
): AccountSeed => ({
  code,
  name,
  groupCode,
  type: AccountType.EXPENSE,
  subType,
  nature,
  section,
  systemKey,
});

export const DEFAULT_ACCOUNTS: readonly AccountSeed[] = [
  // --- Assets ---------------------------------------------------------
  asset(
    "1111",
    "Cash in Hand",
    "1110",
    AccountSubType.CASH_AND_BANK,
    SYSTEM_ACCOUNT.CASH,
  ),
  asset(
    "1112",
    "Bank Account",
    "1110",
    AccountSubType.CASH_AND_BANK,
    SYSTEM_ACCOUNT.BANK,
  ),
  asset(
    "1121",
    "Accounts Receivable",
    "1120",
    AccountSubType.RECEIVABLE,
    SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE,
    {
      partyType: PartyType.CUSTOMER,
      description:
        "Control account for customer balances. Individual customers post to their own sub-ledgers.",
    },
  ),
  asset(
    "1131",
    "Inventory / Closing Stock",
    "1130",
    AccountSubType.INVENTORY,
    SYSTEM_ACCOUNT.INVENTORY,
  ),
  asset(
    "1141",
    "GST Input — CGST",
    "1140",
    AccountSubType.CURRENT_ASSET,
    SYSTEM_ACCOUNT.GST_INPUT_CGST,
  ),
  asset(
    "1142",
    "GST Input — SGST",
    "1140",
    AccountSubType.CURRENT_ASSET,
    SYSTEM_ACCOUNT.GST_INPUT_SGST,
  ),
  asset(
    "1143",
    "GST Input — IGST",
    "1140",
    AccountSubType.CURRENT_ASSET,
    SYSTEM_ACCOUNT.GST_INPUT_IGST,
  ),
  asset(
    "1144",
    "GST Input — Cess",
    "1140",
    AccountSubType.CURRENT_ASSET,
    SYSTEM_ACCOUNT.GST_INPUT_CESS,
  ),
  asset(
    "1151",
    "Prepaid Expenses",
    "1150",
    AccountSubType.CURRENT_ASSET,
    SYSTEM_ACCOUNT.PREPAID_EXPENSES,
  ),
  asset(
    "1201",
    "Fixed Assets",
    "1200",
    AccountSubType.FIXED_ASSET,
    SYSTEM_ACCOUNT.FIXED_ASSETS,
  ),
  // Contra-asset: credit balance netted against fixed assets on the balance sheet.
  {
    code: "1202",
    name: "Accumulated Depreciation",
    groupCode: "1200",
    type: AccountType.ASSET,
    subType: AccountSubType.FIXED_ASSET,
    nature: AccountNature.CREDIT,
    section: StatementSection.BALANCE_SHEET,
    systemKey: SYSTEM_ACCOUNT.ACCUMULATED_DEPRECIATION,
    description: "Contra-asset. Reduces the carrying value of fixed assets.",
  },

  // --- Liabilities ----------------------------------------------------
  liability(
    "2111",
    "Accounts Payable",
    "2110",
    AccountSubType.PAYABLE,
    SYSTEM_ACCOUNT.ACCOUNTS_PAYABLE,
    {
      partyType: PartyType.SUPPLIER,
      description: "Control account for supplier balances.",
    },
  ),
  liability(
    "2121",
    "GST Output — CGST",
    "2120",
    AccountSubType.TAX_LIABILITY,
    SYSTEM_ACCOUNT.GST_OUTPUT_CGST,
  ),
  liability(
    "2122",
    "GST Output — SGST",
    "2120",
    AccountSubType.TAX_LIABILITY,
    SYSTEM_ACCOUNT.GST_OUTPUT_SGST,
  ),
  liability(
    "2123",
    "GST Output — IGST",
    "2120",
    AccountSubType.TAX_LIABILITY,
    SYSTEM_ACCOUNT.GST_OUTPUT_IGST,
  ),
  liability(
    "2124",
    "GST Output — Cess",
    "2120",
    AccountSubType.TAX_LIABILITY,
    SYSTEM_ACCOUNT.GST_OUTPUT_CESS,
  ),
  liability(
    "2125",
    "GST Payable",
    "2120",
    AccountSubType.TAX_LIABILITY,
    SYSTEM_ACCOUNT.GST_PAYABLE,
    {
      description:
        "Net GST liability after setting input credit off against output tax.",
    },
  ),
  liability(
    "2126",
    "TDS Payable",
    "2120",
    AccountSubType.TAX_LIABILITY,
    SYSTEM_ACCOUNT.TDS_PAYABLE,
  ),
  liability(
    "2131",
    "Salary Payable",
    "2130",
    AccountSubType.CURRENT_LIABILITY,
    SYSTEM_ACCOUNT.SALARY_PAYABLE,
  ),
  liability(
    "2132",
    "Accrued Expenses",
    "2130",
    AccountSubType.CURRENT_LIABILITY,
    SYSTEM_ACCOUNT.ACCRUED_EXPENSES,
  ),
  liability(
    "2201",
    "Loans Payable",
    "2200",
    AccountSubType.LOAN,
    SYSTEM_ACCOUNT.LOANS_PAYABLE,
  ),

  // --- Equity ---------------------------------------------------------
  equity(
    "3001",
    "Owner's Capital",
    AccountSubType.CAPITAL,
    AccountNature.CREDIT,
    SYSTEM_ACCOUNT.OWNER_CAPITAL,
  ),
  // Drawings reduce capital, so it carries a debit balance within equity.
  equity(
    "3002",
    "Drawings",
    AccountSubType.DRAWINGS,
    AccountNature.DEBIT,
    SYSTEM_ACCOUNT.DRAWINGS,
  ),
  equity(
    "3003",
    "Retained Earnings",
    AccountSubType.RETAINED_EARNINGS,
    AccountNature.CREDIT,
    SYSTEM_ACCOUNT.RETAINED_EARNINGS,
  ),

  // --- Income ---------------------------------------------------------
  income(
    "4101",
    "Sales",
    "4100",
    AccountSubType.SALES,
    StatementSection.TRADING,
    SYSTEM_ACCOUNT.SALES,
  ),
  // Contra-revenue: debit balance netted against sales.
  income(
    "4102",
    "Sales Returns",
    "4100",
    AccountSubType.SALES,
    StatementSection.TRADING,
    SYSTEM_ACCOUNT.SALES_RETURNS,
    AccountNature.DEBIT,
  ),
  income(
    "4201",
    "Other Income",
    "4200",
    AccountSubType.OTHER_INCOME,
    StatementSection.PROFIT_AND_LOSS,
    SYSTEM_ACCOUNT.OTHER_INCOME,
  ),
  income(
    "4202",
    "Discount Received",
    "4200",
    AccountSubType.OTHER_INCOME,
    StatementSection.PROFIT_AND_LOSS,
    SYSTEM_ACCOUNT.DISCOUNT_RECEIVED,
  ),
  income(
    "4203",
    "Round Off",
    "4200",
    AccountSubType.OTHER_INCOME,
    StatementSection.PROFIT_AND_LOSS,
    SYSTEM_ACCOUNT.ROUND_OFF,
    AccountNature.CREDIT,
  ),

  // --- Direct costs ---------------------------------------------------
  expense(
    "5001",
    "Purchases",
    "5000",
    AccountSubType.PURCHASES,
    StatementSection.TRADING,
    SYSTEM_ACCOUNT.PURCHASES,
  ),
  // Contra-expense: credit balance netted against purchases.
  expense(
    "5002",
    "Purchase Returns",
    "5000",
    AccountSubType.PURCHASES,
    StatementSection.TRADING,
    SYSTEM_ACCOUNT.PURCHASE_RETURNS,
    AccountNature.CREDIT,
  ),
  expense(
    "5003",
    "Cost of Goods Sold",
    "5000",
    AccountSubType.DIRECT_EXPENSE,
    StatementSection.TRADING,
    SYSTEM_ACCOUNT.COST_OF_GOODS_SOLD,
  ),
  expense(
    "5004",
    "Opening Stock",
    "5000",
    AccountSubType.DIRECT_EXPENSE,
    StatementSection.TRADING,
    SYSTEM_ACCOUNT.OPENING_STOCK,
  ),
  expense(
    "5005",
    "Direct Expenses",
    "5000",
    AccountSubType.DIRECT_EXPENSE,
    StatementSection.TRADING,
    SYSTEM_ACCOUNT.DIRECT_EXPENSES,
  ),
  expense(
    "5006",
    "Discount Allowed",
    "5000",
    AccountSubType.DIRECT_EXPENSE,
    StatementSection.TRADING,
    SYSTEM_ACCOUNT.DISCOUNT_ALLOWED,
  ),

  // --- Operating expenses ---------------------------------------------
  expense(
    "6101",
    "Salaries & Wages",
    "6100",
    AccountSubType.INDIRECT_EXPENSE,
    StatementSection.PROFIT_AND_LOSS,
    SYSTEM_ACCOUNT.SALARY_EXPENSE,
  ),
  expense(
    "6102",
    "Rent",
    "6100",
    AccountSubType.INDIRECT_EXPENSE,
    StatementSection.PROFIT_AND_LOSS,
    SYSTEM_ACCOUNT.RENT_EXPENSE,
  ),
  expense(
    "6103",
    "Electricity",
    "6100",
    AccountSubType.INDIRECT_EXPENSE,
    StatementSection.PROFIT_AND_LOSS,
    SYSTEM_ACCOUNT.ELECTRICITY_EXPENSE,
  ),
  expense(
    "6104",
    "Water",
    "6100",
    AccountSubType.INDIRECT_EXPENSE,
    StatementSection.PROFIT_AND_LOSS,
    SYSTEM_ACCOUNT.WATER_EXPENSE,
  ),
  expense(
    "6105",
    "Internet",
    "6100",
    AccountSubType.INDIRECT_EXPENSE,
    StatementSection.PROFIT_AND_LOSS,
    SYSTEM_ACCOUNT.INTERNET_EXPENSE,
  ),
  expense(
    "6106",
    "Telephone",
    "6100",
    AccountSubType.INDIRECT_EXPENSE,
    StatementSection.PROFIT_AND_LOSS,
    SYSTEM_ACCOUNT.TELEPHONE_EXPENSE,
  ),
  expense(
    "6107",
    "Repairs",
    "6100",
    AccountSubType.INDIRECT_EXPENSE,
    StatementSection.PROFIT_AND_LOSS,
    SYSTEM_ACCOUNT.REPAIRS_EXPENSE,
  ),
  expense(
    "6108",
    "Maintenance",
    "6100",
    AccountSubType.INDIRECT_EXPENSE,
    StatementSection.PROFIT_AND_LOSS,
    SYSTEM_ACCOUNT.MAINTENANCE_EXPENSE,
  ),
  expense(
    "6109",
    "Insurance",
    "6100",
    AccountSubType.INDIRECT_EXPENSE,
    StatementSection.PROFIT_AND_LOSS,
    SYSTEM_ACCOUNT.INSURANCE_EXPENSE,
  ),
  expense(
    "6110",
    "Office Expenses",
    "6100",
    AccountSubType.INDIRECT_EXPENSE,
    StatementSection.PROFIT_AND_LOSS,
    SYSTEM_ACCOUNT.OFFICE_EXPENSE,
  ),
  expense(
    "6111",
    "Professional Fees",
    "6100",
    AccountSubType.INDIRECT_EXPENSE,
    StatementSection.PROFIT_AND_LOSS,
    SYSTEM_ACCOUNT.PROFESSIONAL_FEES,
  ),
  expense(
    "6112",
    "Miscellaneous Expenses",
    "6100",
    AccountSubType.INDIRECT_EXPENSE,
    StatementSection.PROFIT_AND_LOSS,
    SYSTEM_ACCOUNT.MISCELLANEOUS_EXPENSE,
  ),
  expense(
    "6201",
    "Advertisement & Marketing",
    "6200",
    AccountSubType.INDIRECT_EXPENSE,
    StatementSection.PROFIT_AND_LOSS,
    SYSTEM_ACCOUNT.ADVERTISEMENT_EXPENSE,
  ),
  expense(
    "6202",
    "Transportation & Freight",
    "6200",
    AccountSubType.INDIRECT_EXPENSE,
    StatementSection.PROFIT_AND_LOSS,
    SYSTEM_ACCOUNT.TRANSPORTATION_EXPENSE,
  ),
  expense(
    "6203",
    "Fuel",
    "6200",
    AccountSubType.INDIRECT_EXPENSE,
    StatementSection.PROFIT_AND_LOSS,
    SYSTEM_ACCOUNT.FUEL_EXPENSE,
  ),
  expense(
    "6301",
    "Bank Charges",
    "6300",
    AccountSubType.FINANCE_COST,
    StatementSection.PROFIT_AND_LOSS,
    SYSTEM_ACCOUNT.BANK_CHARGES,
  ),
  expense(
    "6302",
    "Interest Expense",
    "6300",
    AccountSubType.FINANCE_COST,
    StatementSection.PROFIT_AND_LOSS,
    SYSTEM_ACCOUNT.INTEREST_EXPENSE,
  ),
  expense(
    "6401",
    "Depreciation",
    "6400",
    AccountSubType.DEPRECIATION,
    StatementSection.PROFIT_AND_LOSS,
    SYSTEM_ACCOUNT.DEPRECIATION_EXPENSE,
  ),
] as const;

/** Built-in expense categories, each wired to the ledger it posts to. */
export const DEFAULT_EXPENSE_CATEGORIES: ReadonlyArray<{
  name: string;
  accountKey: SystemAccountKey;
}> = [
  { name: "Salary", accountKey: SYSTEM_ACCOUNT.SALARY_EXPENSE },
  { name: "Rent", accountKey: SYSTEM_ACCOUNT.RENT_EXPENSE },
  { name: "Electricity", accountKey: SYSTEM_ACCOUNT.ELECTRICITY_EXPENSE },
  { name: "Water", accountKey: SYSTEM_ACCOUNT.WATER_EXPENSE },
  { name: "Internet", accountKey: SYSTEM_ACCOUNT.INTERNET_EXPENSE },
  { name: "Telephone", accountKey: SYSTEM_ACCOUNT.TELEPHONE_EXPENSE },
  { name: "Fuel", accountKey: SYSTEM_ACCOUNT.FUEL_EXPENSE },
  { name: "Advertisement", accountKey: SYSTEM_ACCOUNT.ADVERTISEMENT_EXPENSE },
  { name: "Repairs", accountKey: SYSTEM_ACCOUNT.REPAIRS_EXPENSE },
  { name: "Maintenance", accountKey: SYSTEM_ACCOUNT.MAINTENANCE_EXPENSE },
  { name: "Insurance", accountKey: SYSTEM_ACCOUNT.INSURANCE_EXPENSE },
  { name: "Bank Charges", accountKey: SYSTEM_ACCOUNT.BANK_CHARGES },
  { name: "Transportation", accountKey: SYSTEM_ACCOUNT.TRANSPORTATION_EXPENSE },
  { name: "Office Expenses", accountKey: SYSTEM_ACCOUNT.OFFICE_EXPENSE },
  { name: "Professional Fees", accountKey: SYSTEM_ACCOUNT.PROFESSIONAL_FEES },
  { name: "Miscellaneous", accountKey: SYSTEM_ACCOUNT.MISCELLANEOUS_EXPENSE },
] as const;

/**
 * Standard Indian GST slabs. Seeded per company as version 1; a rate change
 * creates a new version rather than mutating history.
 */
export const DEFAULT_TAX_RATES: ReadonlyArray<{
  code: string;
  name: string;
  ratePercent: number;
}> = [
  { code: "GST0", name: "GST 0% (Exempt / Nil Rated)", ratePercent: 0 },
  { code: "GST5", name: "GST 5%", ratePercent: 5 },
  { code: "GST12", name: "GST 12%", ratePercent: 12 },
  { code: "GST18", name: "GST 18%", ratePercent: 18 },
  { code: "GST28", name: "GST 28%", ratePercent: 28 },
] as const;

export const DEFAULT_UNITS: ReadonlyArray<{
  code: string;
  name: string;
  precision: number;
}> = [
  { code: "PCS", name: "Pieces", precision: 0 },
  { code: "KG", name: "Kilogram", precision: 3 },
  { code: "GM", name: "Gram", precision: 0 },
  { code: "LTR", name: "Litre", precision: 3 },
  { code: "ML", name: "Millilitre", precision: 0 },
  { code: "BOX", name: "Box", precision: 0 },
  { code: "PKT", name: "Packet", precision: 0 },
  { code: "DOZ", name: "Dozen", precision: 0 },
  { code: "BAG", name: "Bag", precision: 0 },
  { code: "MTR", name: "Metre", precision: 2 },
] as const;
