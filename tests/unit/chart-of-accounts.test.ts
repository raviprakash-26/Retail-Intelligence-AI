import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACCOUNT_GROUPS,
  DEFAULT_ACCOUNTS,
  DEFAULT_EXPENSE_CATEGORIES,
  DEFAULT_TAX_RATES,
  DEFAULT_UNITS,
} from "@/lib/accounting/chart-of-accounts";
import { SYSTEM_ACCOUNT } from "@/lib/accounting/system-accounts";

/**
 * The chart of accounts is data, and data with a mistake in it produces
 * financial statements with a mistake in them. These checks are what stops a
 * mis-typed group code or a wrong statement section from reaching a balance
 * sheet.
 */

describe("account groups", () => {
  it("has unique codes", () => {
    const codes = DEFAULT_ACCOUNT_GROUPS.map((group) => group.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("references only parents that exist", () => {
    const codes = new Set(DEFAULT_ACCOUNT_GROUPS.map((group) => group.code));
    for (const group of DEFAULT_ACCOUNT_GROUPS) {
      if (group.parentCode) {
        expect(
          codes.has(group.parentCode),
          `${group.code} → ${group.parentCode}`,
        ).toBe(true);
      }
    }
  });

  it("gives each group the nature its type implies", () => {
    for (const group of DEFAULT_ACCOUNT_GROUPS) {
      const expected =
        group.type === "ASSET" || group.type === "EXPENSE" ? "DEBIT" : "CREDIT";
      expect(group.nature, `${group.code} ${group.name}`).toBe(expected);
    }
  });

  it("puts a child in the same statement section as its parent", () => {
    const byCode = new Map(
      DEFAULT_ACCOUNT_GROUPS.map((group) => [group.code, group]),
    );
    for (const group of DEFAULT_ACCOUNT_GROUPS) {
      if (!group.parentCode) continue;
      const parent = byCode.get(group.parentCode);
      // Other Income is deliberately P&L under an otherwise Trading parent.
      if (group.code === "4200") continue;
      expect(group.section, `${group.code}`).toBe(parent?.section);
    }
  });

  it("contains no cycles", () => {
    const byCode = new Map(
      DEFAULT_ACCOUNT_GROUPS.map((group) => [group.code, group]),
    );
    for (const group of DEFAULT_ACCOUNT_GROUPS) {
      const seen = new Set<string>();
      let current = group.parentCode;
      while (current) {
        expect(seen.has(current), `cycle via ${group.code}`).toBe(false);
        seen.add(current);
        current = byCode.get(current)?.parentCode;
      }
    }
  });
});

describe("accounts", () => {
  it("has unique codes", () => {
    const codes = DEFAULT_ACCOUNTS.map((account) => account.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("has unique system keys", () => {
    const keys = DEFAULT_ACCOUNTS.map((account) => account.systemKey).filter(
      Boolean,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("belongs to a group that exists", () => {
    const codes = new Set(DEFAULT_ACCOUNT_GROUPS.map((group) => group.code));
    for (const account of DEFAULT_ACCOUNTS) {
      expect(
        codes.has(account.groupCode),
        `${account.code} → ${account.groupCode}`,
      ).toBe(true);
    }
  });

  it("shares its group's account type", () => {
    const byCode = new Map(
      DEFAULT_ACCOUNT_GROUPS.map((group) => [group.code, group]),
    );
    for (const account of DEFAULT_ACCOUNTS) {
      expect(byCode.get(account.groupCode)?.type, account.code).toBe(
        account.type,
      );
    }
  });

  it("defines every system account key the engine can resolve", () => {
    const defined = new Set(
      DEFAULT_ACCOUNTS.map((account) => account.systemKey),
    );
    for (const key of Object.values(SYSTEM_ACCOUNT)) {
      // CLOSING_STOCK is posted only by the year-end closing entry, which
      // reuses the inventory ledger; it has no standalone account.
      if (key === SYSTEM_ACCOUNT.CLOSING_STOCK) continue;
      expect(defined.has(key), `No account defines systemKey ${key}`).toBe(
        true,
      );
    }
  });

  it("uses conventional numeric blocks per account type", () => {
    const block: Record<string, RegExp> = {
      ASSET: /^1/,
      LIABILITY: /^2/,
      EQUITY: /^3/,
      INCOME: /^4/,
      EXPENSE: /^[56]/,
    };
    for (const account of DEFAULT_ACCOUNTS) {
      expect(
        block[account.type]?.test(account.code),
        `${account.code} ${account.name} is a ${account.type}`,
      ).toBe(true);
    }
  });

  it("gives contra accounts the opposite nature to their type", () => {
    const contra = [
      { key: SYSTEM_ACCOUNT.ACCUMULATED_DEPRECIATION, nature: "CREDIT" },
      { key: SYSTEM_ACCOUNT.SALES_RETURNS, nature: "DEBIT" },
      { key: SYSTEM_ACCOUNT.PURCHASE_RETURNS, nature: "CREDIT" },
      { key: SYSTEM_ACCOUNT.DRAWINGS, nature: "DEBIT" },
    ];

    for (const item of contra) {
      const account = DEFAULT_ACCOUNTS.find((a) => a.systemKey === item.key);
      expect(account?.nature, item.key).toBe(item.nature);
    }
  });

  it("keeps direct costs in the Trading section and overheads in P&L", () => {
    const trading = [
      SYSTEM_ACCOUNT.PURCHASES,
      SYSTEM_ACCOUNT.COST_OF_GOODS_SOLD,
      SYSTEM_ACCOUNT.OPENING_STOCK,
      SYSTEM_ACCOUNT.SALES,
    ];
    for (const key of trading) {
      const account = DEFAULT_ACCOUNTS.find((a) => a.systemKey === key);
      expect(account?.section, key).toBe("TRADING");
    }

    const profitAndLoss = [
      SYSTEM_ACCOUNT.RENT_EXPENSE,
      SYSTEM_ACCOUNT.SALARY_EXPENSE,
      SYSTEM_ACCOUNT.DEPRECIATION_EXPENSE,
      SYSTEM_ACCOUNT.BANK_CHARGES,
    ];
    for (const key of profitAndLoss) {
      const account = DEFAULT_ACCOUNTS.find((a) => a.systemKey === key);
      expect(account?.section, key).toBe("PROFIT_AND_LOSS");
    }
  });

  it("puts every balance-sheet account outside the income statement", () => {
    for (const account of DEFAULT_ACCOUNTS) {
      const isBalanceSheetType =
        account.type === "ASSET" ||
        account.type === "LIABILITY" ||
        account.type === "EQUITY";
      if (isBalanceSheetType) {
        expect(account.section, account.code).toBe("BALANCE_SHEET");
      }
    }
  });
});

describe("expense categories", () => {
  it("maps every category to a defined system account", () => {
    const keys = new Set(DEFAULT_ACCOUNTS.map((account) => account.systemKey));
    for (const category of DEFAULT_EXPENSE_CATEGORIES) {
      expect(keys.has(category.accountKey), category.name).toBe(true);
    }
  });

  it("maps every category to an expense ledger, never to an asset", () => {
    const byKey = new Map(
      DEFAULT_ACCOUNTS.map((account) => [account.systemKey, account]),
    );
    for (const category of DEFAULT_EXPENSE_CATEGORIES) {
      expect(byKey.get(category.accountKey)?.type, category.name).toBe(
        "EXPENSE",
      );
    }
  });

  it("has unique names", () => {
    const names = DEFAULT_EXPENSE_CATEGORIES.map((category) => category.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("tax rates and units", () => {
  it("seeds the standard GST slabs", () => {
    expect(DEFAULT_TAX_RATES.map((rate) => rate.ratePercent)).toEqual([
      0, 5, 12, 18, 28,
    ]);
  });

  it("splits every slab evenly into CGST and SGST", () => {
    // The database CHECK requires cgst + sgst = rate, or igst = rate.
    for (const rate of DEFAULT_TAX_RATES) {
      expect(rate.ratePercent / 2 + rate.ratePercent / 2).toBe(
        rate.ratePercent,
      );
    }
  });

  it("has unique tax codes and unit codes", () => {
    const taxCodes = DEFAULT_TAX_RATES.map((rate) => rate.code);
    expect(new Set(taxCodes).size).toBe(taxCodes.length);

    const unitCodes = DEFAULT_UNITS.map((unit) => unit.code);
    expect(new Set(unitCodes).size).toBe(unitCodes.length);
  });

  it("gives countable units zero decimal places", () => {
    for (const code of ["PCS", "BOX", "PKT", "DOZ", "BAG"]) {
      expect(
        DEFAULT_UNITS.find((unit) => unit.code === code)?.precision,
        code,
      ).toBe(0);
    }
  });
});
