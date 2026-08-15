import type { FieldSpec } from "@/lib/import/columns";

/**
 * What can be brought in, and under what headings.
 *
 * Three lists, because these are what a shop actually arrives with and what
 * would otherwise be typed in by hand: the catalogue, the people who owe money,
 * and the people owed. Everything else in this product is produced by trading
 * rather than imported.
 *
 * Deliberately not here: sales, purchases and journal entries. A business's
 * history belongs in its old system's records and its opening position belongs
 * in opening balances — importing a year of invoices would mean inventing the
 * stock movements and tax entries behind them, and this product would be
 * asserting a ledger it did not post. Opening balances come in on the party and
 * product rows, where they post the same balanced entries the forms do.
 */

export type DatasetKey = "products" | "customers" | "suppliers";

export type Dataset = {
  key: DatasetKey;
  title: string;
  /** What a person should understand before they upload. */
  note: string;
  fields: readonly FieldSpec[];
  /** A file the page offers, so nobody has to guess the headings. */
  template: readonly string[];
};

const partyFields: readonly FieldSpec[] = [
  {
    key: "name",
    synonyms: [
      "name",
      "party name",
      "account name",
      "customer name",
      "supplier name",
    ],
    required: true,
  },
  { key: "phone", synonyms: ["phone", "mobile", "contact number", "contact"] },
  { key: "email", synonyms: ["email", "e mail", "email address"] },
  { key: "gstin", synonyms: ["gstin", "gst number", "gst no", "gst"] },
  { key: "pan", synonyms: ["pan", "pan number"] },
  { key: "addressLine1", synonyms: ["address", "address line 1", "street"] },
  { key: "city", synonyms: ["city", "town"] },
  { key: "stateCode", synonyms: ["state code", "state"] },
  { key: "pincode", synonyms: ["pincode", "pin code", "postal code", "zip"] },
  { key: "creditDays", synonyms: ["credit days", "payment terms", "terms"] },
  {
    key: "openingBalance",
    synonyms: ["opening balance", "opening", "balance", "outstanding"],
  },
];

export const DATASETS: Record<DatasetKey, Dataset> = {
  products: {
    key: "products",
    title: "Products",
    note: "Units, categories and tax rates are matched by name against what this business already has. A unit that does not exist stops the row rather than being created, so a typo does not quietly add a unit called 'Pcs.' beside your 'PCS'.",
    fields: [
      {
        key: "sku",
        synonyms: ["sku", "item code", "product code", "code"],
        required: true,
      },
      {
        key: "name",
        synonyms: ["name", "product name", "item name", "description of goods"],
        required: true,
      },
      { key: "description", synonyms: ["description", "details"] },
      { key: "barcode", synonyms: ["barcode", "ean", "upc"] },
      { key: "hsnCode", synonyms: ["hsn", "hsn code", "sac", "hsn sac"] },
      { key: "category", synonyms: ["category", "group", "product group"] },
      {
        key: "unit",
        synonyms: ["unit", "uom", "unit of measure"],
        required: true,
      },
      {
        key: "taxRate",
        synonyms: ["tax rate", "gst rate", "gst percent", "tax"],
      },
      {
        key: "purchasePrice",
        synonyms: ["purchase price", "cost price", "cost", "buy price"],
      },
      {
        key: "sellingPrice",
        synonyms: ["selling price", "sale price", "rate", "price"],
      },
      { key: "mrp", synonyms: ["mrp", "maximum retail price"] },
      {
        key: "openingQuantity",
        synonyms: ["opening quantity", "opening stock", "stock", "quantity"],
      },
      {
        key: "openingRate",
        synonyms: ["opening rate", "opening cost", "stock rate"],
      },
      {
        key: "minStockLevel",
        synonyms: ["reorder level", "minimum stock", "min stock"],
      },
    ],
    template: [
      "SKU,Name,Unit,Category,HSN,Tax Rate,Purchase Price,Selling Price,MRP,Opening Stock,Opening Rate,Reorder Level",
      "RICE-5KG,Sona Masoori Rice 5kg,PCS,Groceries,1006,5,240,285,300,40,240,10",
      "OIL-1L,Sunflower Oil 1L,PCS,Groceries,1512,5,110,132,140,25,110,6",
    ],
  },

  customers: {
    key: "customers",
    title: "Customers",
    note: "An opening balance is what the customer owed you on the day your books start here. It posts as a balanced journal entry against opening capital, exactly as the form does — nothing is stored beside the record.",
    fields: [
      ...partyFields,
      { key: "creditLimit", synonyms: ["credit limit", "limit"] },
    ],
    template: [
      "Name,Phone,GSTIN,City,State Code,Pincode,Credit Days,Credit Limit,Opening Balance",
      "Sharma Provision Store,9845012345,29AAAPR1234K1ZP,Bengaluru,29,560053,30,100000,12500",
      "Anand General Stores,9845098765,,Mysuru,29,570001,15,50000,0",
    ],
  },

  suppliers: {
    key: "suppliers",
    title: "Suppliers",
    note: "An opening balance is what you owed the supplier on the day your books start here, and posts the same way — as a balanced entry rather than a number stored next to the name.",
    fields: partyFields,
    template: [
      "Name,Phone,GSTIN,City,State Code,Pincode,Credit Days,Opening Balance",
      "Metro Wholesale,9845011111,29AAACM1234K1Z5,Bengaluru,29,560002,30,48000",
      "Kumar Traders,9845022222,,Bengaluru,29,560004,15,0",
    ],
  },
};

export function datasetList(): Dataset[] {
  return Object.values(DATASETS);
}
