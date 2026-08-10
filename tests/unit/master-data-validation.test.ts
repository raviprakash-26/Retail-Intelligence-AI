import { describe, expect, it } from "vitest";
import {
  categorySchema,
  customerSchema,
  employeeSchema,
  marginWarning,
  productSchema,
  supplierSchema,
  unitSchema,
  type CustomerInput,
  type EmployeeInput,
  type ProductInput,
} from "@/lib/validation/master-data";
import { gstIdentityIssue } from "@/lib/constants/india";

function customer(overrides: Partial<CustomerInput> = {}): CustomerInput {
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
    creditDays: 0,
    creditLimit: 0,
    openingBalance: 0,
    openingNature: "DEBIT",
    notes: "",
    ...overrides,
  };
}

function product(overrides: Partial<ProductInput> = {}): ProductInput {
  return {
    sku: "RICE-25",
    name: "Sona Masoori Rice",
    description: "",
    barcode: "",
    hsnCode: "",
    categoryId: "",
    unitId: "unit-1",
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

function employee(overrides: Partial<EmployeeInput> = {}): EmployeeInput {
  return {
    name: "Suresh Kumar",
    email: "",
    phone: "",
    department: "",
    designation: "",
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

function firstIssuePath(result: { success: boolean; error?: unknown }): string {
  const error = result.error as { issues: Array<{ path: PropertyKey[] }> };
  return error.issues.map((issue) => issue.path.join(".")).join(",");
}

describe("GSTIN cross-checks", () => {
  it("accepts a GSTIN whose state and PAN agree with the fields beside it", () => {
    expect(
      gstIdentityIssue({
        gstin: "29AABCS1429B1ZX",
        pan: "AABCS1429B",
        stateCode: "29",
      }),
    ).toBeNull();
  });

  it("names the state the GSTIN actually belongs to", () => {
    const issue = gstIdentityIssue({ gstin: "29AABCS1429B1ZX", stateCode: "27" });
    expect(issue?.field).toBe("gstin");
    // The message has to be actionable: "does not match" alone leaves the user
    // guessing which of the two fields is wrong.
    expect(issue?.message).toContain("Karnataka");
  });

  it("catches a PAN that disagrees with the one inside the GSTIN", () => {
    const issue = gstIdentityIssue({
      gstin: "29AABCS1429B1ZX",
      pan: "AAAPR1234K",
      stateCode: "29",
    });
    expect(issue?.field).toBe("pan");
  });

  it("says nothing when there is no GSTIN to check against", () => {
    expect(gstIdentityIssue({ pan: "AAAPR1234K", stateCode: "29" })).toBeNull();
  });

  it("ignores a malformed GSTIN, which the format rule reports instead", () => {
    expect(gstIdentityIssue({ gstin: "NOTAGSTIN", stateCode: "29" })).toBeNull();
  });
});

describe("customer and supplier schemas", () => {
  it("needs only a name", () => {
    expect(customerSchema.safeParse(customer()).success).toBe(true);
  });

  it("applies the GSTIN state rule through the schema", () => {
    const result = customerSchema.safeParse(
      customer({ gstin: "29AABCS1429B1ZX", stateCode: "27" }),
    );
    expect(result.success).toBe(false);
    expect(firstIssuePath(result)).toContain("gstin");
  });

  it("rejects a negative opening balance — the side is a separate field", () => {
    const result = customerSchema.safeParse(
      customer({ openingBalance: -5000 }),
    );
    expect(result.success).toBe(false);
  });

  it("keeps an opening balance on the credit side when asked", () => {
    const result = customerSchema.safeParse(
      customer({ openingBalance: 5000, openingNature: "CREDIT" }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects credit days beyond a year", () => {
    expect(customerSchema.safeParse(customer({ creditDays: 400 })).success).toBe(
      false,
    );
  });

  it("uppercases a GSTIN typed in lower case", () => {
    const result = customerSchema.safeParse(
      customer({ gstin: "29aabcs1429b1zx", stateCode: "29" }),
    );
    expect(result.success).toBe(true);
    expect(result.data?.gstin).toBe("29AABCS1429B1ZX");
  });

  it("has no credit limit on a supplier", () => {
    const { creditLimit: _ignored, ...supplier } = customer();
    expect(supplierSchema.safeParse(supplier).success).toBe(true);
  });
});

describe("product schema", () => {
  it("accepts a plain product", () => {
    expect(productSchema.safeParse(product()).success).toBe(true);
  });

  it("rejects a SKU with spaces, which breaks barcode and CSV round-trips", () => {
    const result = productSchema.safeParse(product({ sku: "RICE 25 KG" }));
    expect(result.success).toBe(false);
    expect(firstIssuePath(result)).toContain("sku");
  });

  it.each(["1006", "100610", "10061010"])("accepts a %s-digit HSN", (hsn) => {
    expect(productSchema.safeParse(product({ hsnCode: hsn })).success).toBe(true);
  });

  it.each(["100", "10061", "1006101012", "ABCD"])(
    "rejects %s as an HSN",
    (hsn) => {
      expect(productSchema.safeParse(product({ hsnCode: hsn })).success).toBe(
        false,
      );
    },
  );

  it("rejects an MRP below the selling price", () => {
    const result = productSchema.safeParse(
      product({ sellingPrice: 1620, mrp: 1500 }),
    );
    expect(result.success).toBe(false);
    expect(firstIssuePath(result)).toContain("mrp");
  });

  it("treats a zero MRP as 'not printed on the pack'", () => {
    expect(
      productSchema.safeParse(product({ sellingPrice: 1620, mrp: 0 })).success,
    ).toBe(true);
  });

  it("refuses opening stock on something not stock-tracked", () => {
    const result = productSchema.safeParse(
      product({ isStockTracked: false, openingQuantity: 10, openingRate: 5 }),
    );
    expect(result.success).toBe(false);
    expect(firstIssuePath(result)).toContain("openingQuantity");
  });

  it("refuses opening stock with no cost — it would value the balance sheet at nothing", () => {
    const result = productSchema.safeParse(
      product({ openingQuantity: 40, openingRate: 0 }),
    );
    expect(result.success).toBe(false);
    expect(firstIssuePath(result)).toContain("openingRate");
  });

  it("allows a service with no stock at all", () => {
    expect(
      productSchema.safeParse(
        product({ isStockTracked: false, openingQuantity: 0, openingRate: 0 }),
      ).success,
    ).toBe(true);
  });
});

describe("margin warning", () => {
  it("warns when the selling price is below cost", () => {
    expect(marginWarning({ purchasePrice: 100, sellingPrice: 90 })).toContain(
      "loss",
    );
  });

  it("stays quiet on a normal margin", () => {
    expect(marginWarning({ purchasePrice: 100, sellingPrice: 120 })).toBeNull();
  });

  it("stays quiet while the form is still empty", () => {
    expect(marginWarning({ purchasePrice: 0, sellingPrice: 0 })).toBeNull();
  });
});

describe("employee schema", () => {
  it("accepts someone currently employed", () => {
    expect(employeeSchema.safeParse(employee()).success).toBe(true);
  });

  it("requires a leaving date once someone has left", () => {
    const result = employeeSchema.safeParse(employee({ status: "RESIGNED" }));
    expect(result.success).toBe(false);
    expect(firstIssuePath(result)).toContain("exitDate");
  });

  it("rejects a leaving date before the joining date", () => {
    const result = employeeSchema.safeParse(
      employee({ status: "RESIGNED", exitDate: "2025-01-01" }),
    );
    expect(result.success).toBe(false);
    expect(firstIssuePath(result)).toContain("exitDate");
  });

  it("rejects a leaving date on someone still marked active", () => {
    const result = employeeSchema.safeParse(
      employee({ status: "ACTIVE", exitDate: "2026-01-01" }),
    );
    expect(result.success).toBe(false);
    expect(firstIssuePath(result)).toContain("status");
  });

  it("rejects an IFSC in the wrong shape", () => {
    expect(employeeSchema.safeParse(employee({ ifsc: "CNRB123" })).success).toBe(
      false,
    );
    expect(
      employeeSchema.safeParse(employee({ ifsc: "CNRB0000421" })).success,
    ).toBe(true);
  });
});

describe("taxonomy schemas", () => {
  it("accepts a category with just a name", () => {
    expect(
      categorySchema.safeParse({ name: "Staples", parentId: "", description: "" })
        .success,
    ).toBe(true);
  });

  it("rejects a unit code with punctuation", () => {
    expect(
      unitSchema.safeParse({ code: "K-G", name: "Kilogram", precision: 3 })
        .success,
    ).toBe(false);
  });

  it("caps unit precision at three decimals", () => {
    expect(
      unitSchema.safeParse({ code: "KG", name: "Kilogram", precision: 4 })
        .success,
    ).toBe(false);
    expect(
      unitSchema.safeParse({ code: "KG", name: "Kilogram", precision: 3 })
        .success,
    ).toBe(true);
  });
});
