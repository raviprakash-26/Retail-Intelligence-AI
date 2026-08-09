/**
 * Indian jurisdiction reference data.
 *
 * The GST state code is not cosmetic: comparing the supplier's state code with
 * the place of supply is what decides whether a transaction is taxed as
 * CGST + SGST or as IGST. Getting it wrong misstates the return.
 */

export type IndianState = {
  /** Two-digit GST state code, as used in the first two digits of a GSTIN. */
  code: string;
  name: string;
  type: "state" | "union-territory";
};

export const INDIAN_STATES: readonly IndianState[] = [
  { code: "01", name: "Jammu and Kashmir", type: "union-territory" },
  { code: "02", name: "Himachal Pradesh", type: "state" },
  { code: "03", name: "Punjab", type: "state" },
  { code: "04", name: "Chandigarh", type: "union-territory" },
  { code: "05", name: "Uttarakhand", type: "state" },
  { code: "06", name: "Haryana", type: "state" },
  { code: "07", name: "Delhi", type: "union-territory" },
  { code: "08", name: "Rajasthan", type: "state" },
  { code: "09", name: "Uttar Pradesh", type: "state" },
  { code: "10", name: "Bihar", type: "state" },
  { code: "11", name: "Sikkim", type: "state" },
  { code: "12", name: "Arunachal Pradesh", type: "state" },
  { code: "13", name: "Nagaland", type: "state" },
  { code: "14", name: "Manipur", type: "state" },
  { code: "15", name: "Mizoram", type: "state" },
  { code: "16", name: "Tripura", type: "state" },
  { code: "17", name: "Meghalaya", type: "state" },
  { code: "18", name: "Assam", type: "state" },
  { code: "19", name: "West Bengal", type: "state" },
  { code: "20", name: "Jharkhand", type: "state" },
  { code: "21", name: "Odisha", type: "state" },
  { code: "22", name: "Chhattisgarh", type: "state" },
  { code: "23", name: "Madhya Pradesh", type: "state" },
  { code: "24", name: "Gujarat", type: "state" },
  {
    code: "26",
    name: "Dadra and Nagar Haveli and Daman and Diu",
    type: "union-territory",
  },
  { code: "27", name: "Maharashtra", type: "state" },
  { code: "29", name: "Karnataka", type: "state" },
  { code: "30", name: "Goa", type: "state" },
  { code: "31", name: "Lakshadweep", type: "union-territory" },
  { code: "32", name: "Kerala", type: "state" },
  { code: "33", name: "Tamil Nadu", type: "state" },
  { code: "34", name: "Puducherry", type: "union-territory" },
  { code: "35", name: "Andaman and Nicobar Islands", type: "union-territory" },
  { code: "36", name: "Telangana", type: "state" },
  { code: "37", name: "Andhra Pradesh", type: "state" },
  { code: "38", name: "Ladakh", type: "union-territory" },
  { code: "97", name: "Other Territory", type: "union-territory" },
] as const;

export function findStateByCode(code: string): IndianState | undefined {
  return INDIAN_STATES.find((state) => state.code === code);
}

export function findStateByName(name: string): IndianState | undefined {
  const normalised = name.trim().toLowerCase();
  return INDIAN_STATES.find((state) => state.name.toLowerCase() === normalised);
}

/**
 * GSTIN format: 2-digit state code, 10-character PAN, 1-digit entity number,
 * the letter Z, and a checksum character.
 */
export const GSTIN_PATTERN =
  /^[0-3][0-9][A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

/** PAN format: 5 letters, 4 digits, 1 letter. */
export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export const PINCODE_PATTERN = /^[1-9][0-9]{5}$/;

/** Indian mobile numbers start 6-9 and are 10 digits, optionally +91 prefixed. */
export const INDIAN_MOBILE_PATTERN = /^(?:\+?91[-\s]?)?[6-9]\d{9}$/;

/**
 * The state code embedded in a GSTIN must match the registered state. A
 * mismatch usually means the GSTIN was typed for the wrong branch.
 */
export function gstinStateCode(gstin: string): string | null {
  if (!GSTIN_PATTERN.test(gstin.toUpperCase())) return null;
  return gstin.slice(0, 2);
}

/** The PAN embedded in a GSTIN, for cross-checking the two fields. */
export function panFromGstin(gstin: string): string | null {
  if (!GSTIN_PATTERN.test(gstin.toUpperCase())) return null;
  return gstin.slice(2, 12);
}

export const BUSINESS_TYPE_OPTIONS = [
  { value: "SOLE_PROPRIETORSHIP", label: "Sole Proprietorship" },
  { value: "PARTNERSHIP", label: "Partnership Firm" },
  { value: "LLP", label: "Limited Liability Partnership" },
  { value: "PRIVATE_LIMITED", label: "Private Limited Company" },
  { value: "PUBLIC_LIMITED", label: "Public Limited Company" },
  { value: "HUF", label: "Hindu Undivided Family" },
  { value: "OTHER", label: "Other" },
] as const;

export const GST_REGISTRATION_OPTIONS = [
  {
    value: "UNREGISTERED",
    label: "Not registered for GST",
    hint: "Turnover below the registration threshold.",
  },
  {
    value: "REGULAR",
    label: "Regular scheme",
    hint: "Charges GST on sales and claims input tax credit.",
  },
  {
    value: "COMPOSITION",
    label: "Composition scheme",
    hint: "Pays tax at a flat rate; cannot claim input tax credit.",
  },
  {
    value: "SEZ",
    label: "SEZ unit or developer",
    hint: "Supplies treated as zero-rated.",
  },
] as const;

/**
 * The Indian financial year runs April to March. Returns the label for the
 * year containing `date`, e.g. "2026-27".
 */
export function fiscalYearLabel(date: Date, startMonth = 4): string {
  const month = date.getMonth() + 1;
  const year = date.getFullYear();
  const startYear = month >= startMonth ? year : year - 1;
  const endYear = (startYear + 1) % 100;
  return `${startYear}-${String(endYear).padStart(2, "0")}`;
}

/** Inclusive start and end dates of the fiscal year containing `date`. */
export function fiscalYearRange(
  date: Date,
  startMonth = 4,
): { start: Date; end: Date; label: string } {
  const month = date.getMonth() + 1;
  const year = date.getFullYear();
  const startYear = month >= startMonth ? year : year - 1;

  return {
    start: new Date(Date.UTC(startYear, startMonth - 1, 1)),
    // Day 0 of the start month one year on is the last day of the FY.
    end: new Date(Date.UTC(startYear + 1, startMonth - 1, 0)),
    label: fiscalYearLabel(date, startMonth),
  };
}
