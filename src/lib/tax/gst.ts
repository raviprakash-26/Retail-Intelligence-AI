import {
  Decimal,
  add,
  isZero,
  money,
  multiply,
  netFromInclusive,
  percentOf,
  round2,
  roundOffDifference,
  subtract,
  sum,
  type MoneyInput,
} from "@/lib/money";

/**
 * GST computation.
 *
 * Pure: no database, no framework. Every tax figure the product shows or posts
 * comes from here, so the rules exist once and can be tested exhaustively.
 *
 * Two decisions dominate Indian GST on a sales invoice:
 *
 *   1. **Where the supply happens.** If the place of supply is the seller's own
 *      state the tax splits into CGST + SGST; otherwise it is a single IGST
 *      charge. Getting this wrong does not change what the customer pays but
 *      does misstate the return, and the two are reported in different tables.
 *
 *   2. **Whether tax may be charged at all.** An unregistered seller and a
 *      composition dealer must not charge GST on an invoice — a composition
 *      dealer issues a bill of supply and pays tax out of their own margin.
 *      Charging it anyway is a compliance failure, not a rounding difference.
 */

export type SupplyType =
  | "INTRA_STATE"
  | "INTER_STATE"
  | "EXPORT"
  | "EXEMPT"
  | "NIL_RATED"
  | "NON_GST";

export type GstRegistration =
  | "UNREGISTERED"
  | "REGULAR"
  | "COMPOSITION"
  | "SEZ";

/** True when the seller may show GST on the face of the invoice. */
export function chargesTax(supplyType: SupplyType): boolean {
  return supplyType === "INTRA_STATE" || supplyType === "INTER_STATE";
}

/**
 * Which tax treatment applies to a supply.
 *
 * `placeOfSupply` is the customer's state code. When it is unknown — a walk-in
 * counter sale, typically — the supply is treated as happening where the shop
 * is, which is what actually occurs when a customer carries goods out.
 */
export function resolveSupplyType(params: {
  registration: GstRegistration;
  sellerStateCode: string | null;
  placeOfSupplyStateCode: string | null;
}): SupplyType {
  if (params.registration === "UNREGISTERED") return "NON_GST";
  // A composition dealer cannot collect GST from the customer, so nothing is
  // charged on the invoice regardless of where the supply lands.
  if (params.registration === "COMPOSITION") return "NON_GST";
  if (params.registration === "SEZ") return "EXPORT";

  const seller = params.sellerStateCode?.trim();
  const buyer = params.placeOfSupplyStateCode?.trim() || seller;
  if (!seller || !buyer) return "INTRA_STATE";

  return seller === buyer ? "INTRA_STATE" : "INTER_STATE";
}

export type GstLineInput = {
  quantity: MoneyInput;
  /** Price per unit, before any discount. */
  rate: MoneyInput;
  /** Percentage taken off the line, applied before any flat discount. */
  discountPercent?: MoneyInput;
  /** Flat amount taken off the line, after the percentage. */
  discountAmount?: MoneyInput;
  taxPercent: MoneyInput;
  cessPercent?: MoneyInput;
  /** The rate already includes tax — an MRP-priced counter sale. */
  priceIncludesTax?: boolean;
};

export type GstLineResult = {
  /** Quantity × rate, before discount. */
  grossAmount: Decimal;
  discountAmount: Decimal;
  /** The value GST is charged on, and what the P&L records as revenue. */
  taxableAmount: Decimal;
  taxPercent: Decimal;
  cgstAmount: Decimal;
  sgstAmount: Decimal;
  igstAmount: Decimal;
  cessAmount: Decimal;
  /** Taxable + all taxes. Invoice round-off is applied at the total, not here. */
  lineTotal: Decimal;
};

/**
 * Splits a tax charge into its halves so they always sum back to the whole.
 *
 * Halving 18% of ₹1,234.50 gives ₹111.105 twice; rounding each to ₹111.11 and
 * adding them back produces a paisa the invoice total does not contain, and a
 * journal entry that does not balance. So the total is rounded once and the
 * halves are derived from it — the second half absorbs the odd paisa.
 */
export function splitIntoHalves(total: MoneyInput): [Decimal, Decimal] {
  const whole = round2(total);
  const first = whole.dividedBy(2).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return [first, subtract(whole, first)];
}

export function computeLine(
  line: GstLineInput,
  supplyType: SupplyType,
): GstLineResult {
  const taxPercent = chargesTax(supplyType) ? money(line.taxPercent) : money(0);
  const cessPercent = chargesTax(supplyType)
    ? money(line.cessPercent ?? 0)
    : money(0);

  const gross = multiply(line.quantity, line.rate);
  const percentDiscount = percentOf(gross, line.discountPercent ?? 0);
  const discount = round2(add(percentDiscount, line.discountAmount ?? 0));
  const net = subtract(gross, discount);

  // A tax-inclusive price has to be unwound before anything else: the taxable
  // value is what remains once the tax already sitting inside it is removed.
  const taxable = line.priceIncludesTax
    ? round2(netFromInclusive(net, add(taxPercent, cessPercent)))
    : round2(net);

  const totalTax = round2(percentOf(taxable, taxPercent));
  const cess = round2(percentOf(taxable, cessPercent));

  let cgst = money(0);
  let sgst = money(0);
  let igst = money(0);

  if (supplyType === "INTRA_STATE") {
    [cgst, sgst] = splitIntoHalves(totalTax);
  } else if (supplyType === "INTER_STATE") {
    igst = totalTax;
  }

  return {
    grossAmount: round2(gross),
    discountAmount: discount,
    taxableAmount: taxable,
    taxPercent,
    cgstAmount: cgst,
    sgstAmount: sgst,
    igstAmount: igst,
    cessAmount: cess,
    lineTotal: add(taxable, cgst, sgst, igst, cess),
  };
}

export type GstTotals = {
  subTotal: Decimal;
  discountAmount: Decimal;
  taxableAmount: Decimal;
  cgstAmount: Decimal;
  sgstAmount: Decimal;
  igstAmount: Decimal;
  cessAmount: Decimal;
  /** Difference between the exact total and the rounded one it is billed at. */
  roundOff: Decimal;
  totalAmount: Decimal;
};

/**
 * Adds the lines up and rounds the invoice to the rupee.
 *
 * Indian invoices are rounded to the nearest rupee, and the difference is
 * posted to its own account rather than quietly absorbed into revenue — a
 * fraction of a paisa hidden in sales is exactly the sort of thing that makes
 * a trial balance stop tying out.
 */
export function totalLines(
  lines: readonly GstLineResult[],
  options: { roundToRupee?: boolean } = {},
): GstTotals {
  const subTotal = sum(lines.map((line) => line.grossAmount));
  const discountAmount = sum(lines.map((line) => line.discountAmount));
  const taxableAmount = sum(lines.map((line) => line.taxableAmount));
  const cgstAmount = sum(lines.map((line) => line.cgstAmount));
  const sgstAmount = sum(lines.map((line) => line.sgstAmount));
  const igstAmount = sum(lines.map((line) => line.igstAmount));
  const cessAmount = sum(lines.map((line) => line.cessAmount));

  const exactTotal = add(
    taxableAmount,
    cgstAmount,
    sgstAmount,
    igstAmount,
    cessAmount,
  );

  const roundOff =
    options.roundToRupee === false ? money(0) : roundOffDifference(exactTotal);

  return {
    subTotal,
    discountAmount,
    taxableAmount,
    cgstAmount,
    sgstAmount,
    igstAmount,
    cessAmount,
    roundOff,
    totalAmount: add(exactTotal, roundOff),
  };
}

/**
 * Groups lines the way a GST return does — by rate and HSN.
 *
 * GSTR-1 reports outward supplies summarised this way, so producing it at
 * posting time means the return is assembled from the same figures the invoice
 * was raised with rather than recomputed later from prices and rates.
 */
export type GstRateGroup = {
  hsnCode: string | null;
  taxPercent: Decimal;
  taxableAmount: Decimal;
  cgstAmount: Decimal;
  sgstAmount: Decimal;
  igstAmount: Decimal;
  cessAmount: Decimal;
  totalTax: Decimal;
};

export function groupByRate(
  lines: readonly (GstLineResult & { hsnCode?: string | null })[],
): GstRateGroup[] {
  const groups = new Map<string, GstRateGroup>();

  for (const line of lines) {
    const hsn = line.hsnCode?.trim() || null;
    const key = `${hsn ?? ""}|${line.taxPercent.toFixed(4)}`;
    const existing = groups.get(key);

    if (!existing) {
      groups.set(key, {
        hsnCode: hsn,
        taxPercent: line.taxPercent,
        taxableAmount: line.taxableAmount,
        cgstAmount: line.cgstAmount,
        sgstAmount: line.sgstAmount,
        igstAmount: line.igstAmount,
        cessAmount: line.cessAmount,
        totalTax: add(
          line.cgstAmount,
          line.sgstAmount,
          line.igstAmount,
          line.cessAmount,
        ),
      });
      continue;
    }

    existing.taxableAmount = add(existing.taxableAmount, line.taxableAmount);
    existing.cgstAmount = add(existing.cgstAmount, line.cgstAmount);
    existing.sgstAmount = add(existing.sgstAmount, line.sgstAmount);
    existing.igstAmount = add(existing.igstAmount, line.igstAmount);
    existing.cessAmount = add(existing.cessAmount, line.cessAmount);
    existing.totalTax = add(
      existing.cgstAmount,
      existing.sgstAmount,
      existing.igstAmount,
      existing.cessAmount,
    );
  }

  return [...groups.values()];
}

/**
 * Why an invoice shows no tax, in words a retailer can act on.
 *
 * Silence here is what leads someone to believe the software forgot the GST,
 * and then to add it by hand somewhere it does not belong.
 */
export function describeSupplyType(
  supplyType: SupplyType,
  registration: GstRegistration,
): string | null {
  if (chargesTax(supplyType)) return null;

  switch (registration) {
    case "UNREGISTERED":
      return "Your business is not registered for GST, so no tax is charged and this is a bill of supply rather than a tax invoice.";
    case "COMPOSITION":
      return "Composition dealers cannot collect GST from customers. This is a bill of supply; the tax you owe is worked out on your turnover instead.";
    case "SEZ":
      return "Supplies from an SEZ are zero-rated, so no tax is charged on the invoice.";
    default:
      return "No GST is charged on this supply.";
  }
}

/** True when every figure that should sum to the total actually does. */
export function totalsReconcile(totals: GstTotals): boolean {
  const rebuilt = add(
    totals.taxableAmount,
    totals.cgstAmount,
    totals.sgstAmount,
    totals.igstAmount,
    totals.cessAmount,
    totals.roundOff,
  );
  return isZero(subtract(rebuilt, totals.totalAmount));
}
