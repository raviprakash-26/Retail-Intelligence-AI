import {
  add,
  compare,
  max,
  money,
  percentOf,
  subtract,
  type Decimal,
  type MoneyInput,
} from "@/lib/money";

/**
 * Depreciation under the Income-tax Act.
 *
 * This is not the depreciation in the accounts, and the two are not meant to
 * agree. The books write an asset down over its useful life; the Act writes a
 * *block* of assets down at a prescribed percentage of its written-down value,
 * whatever the accountant thought the asset would last. So the computation adds
 * the book charge back and takes this one instead.
 *
 * Three rules do most of the work, and all three are places a hand-rolled
 * spreadsheet usually goes wrong:
 *
 *   1. **Assets are pooled into blocks, not tracked individually.** A block is
 *      one running balance. There is no per-asset written-down value in the Act,
 *      and inventing one produces a different answer the moment anything is
 *      sold. A block is a *class* of assets — buildings, machinery, plant,
 *      furniture, intangibles — sharing a prescribed rate, so it takes both to
 *      identify one: buildings and furniture are each written down at 10% and
 *      are still two blocks, while a delivery van and a chest freezer are both
 *      machinery and plant at 15% and are genuinely one.
 *   2. **An asset put to use for less than 180 days in the year it was bought
 *      gets half the rate** — and only in that year.
 *   3. **Sale proceeds come off the block**, not off the asset. If they exceed
 *      what is left in the block, the block goes to nil and there is no
 *      depreciation at all; what happens next is a capital gains question this
 *      does not answer.
 *
 * Rates are the ones in Appendix I to the Income-tax Rules, capped at 40% since
 * assessment year 2018-19.
 */

export type BlockKey =
  | "BUILDING_RESIDENTIAL"
  | "BUILDING_OTHER"
  | "FURNITURE"
  | "PLANT_MACHINERY"
  | "MOTOR_VEHICLE"
  | "COMPUTER"
  | "INTANGIBLE";

export type Block = {
  key: BlockKey;
  label: string;
  ratePercent: number;
  /**
   * Words that, in an asset's category or name, point at this block. Used only
   * when the asset record carries no rate of its own — and the working paper
   * always shows which block an asset landed in, so a wrong guess is visible
   * rather than buried.
   */
  keywords: readonly string[];
};

export const BLOCKS: readonly Block[] = [
  {
    key: "COMPUTER",
    label: "Computers and software",
    ratePercent: 40,
    keywords: [
      "computer",
      "laptop",
      "desktop",
      "server",
      "printer",
      "software",
      "tablet",
      "pos terminal",
      "billing machine",
    ],
  },
  {
    key: "INTANGIBLE",
    label: "Intangible assets",
    ratePercent: 25,
    keywords: [
      "trademark",
      "patent",
      "copyright",
      "licence",
      "license",
      "goodwill",
      "know-how",
      "franchise",
    ],
  },
  {
    key: "BUILDING_RESIDENTIAL",
    label: "Buildings — residential",
    ratePercent: 5,
    keywords: ["residential", "quarters", "staff housing"],
  },
  {
    key: "BUILDING_OTHER",
    label: "Buildings — other than residential",
    ratePercent: 10,
    keywords: [
      "building",
      "shop premises",
      "godown",
      "warehouse",
      "office premises",
    ],
  },
  {
    key: "FURNITURE",
    label: "Furniture and fittings",
    ratePercent: 10,
    keywords: [
      "furniture",
      "fitting",
      "shelf",
      "shelving",
      "rack",
      "counter",
      "chair",
      "table",
      "cupboard",
      "interior",
    ],
  },
  {
    key: "MOTOR_VEHICLE",
    label: "Motor vehicles",
    ratePercent: 15,
    keywords: [
      "vehicle",
      "car",
      "van",
      "scooter",
      "motorcycle",
      "bike",
      "tempo",
      "truck",
      "delivery vehicle",
    ],
  },
  {
    key: "PLANT_MACHINERY",
    label: "Plant and machinery",
    ratePercent: 15,
    keywords: [
      "machine",
      "machinery",
      "plant",
      "equipment",
      "refrigerator",
      "freezer",
      "air conditioner",
      "generator",
      "weighing",
    ],
  },
] as const;

/** Where anything unrecognised goes. The general rate for plant and machinery. */
export const DEFAULT_BLOCK: BlockKey = "PLANT_MACHINERY";

/**
 * The classes section 2(11) sorts assets into before the rate is looked at.
 *
 * A block is a class *and* a rate, not a rate alone. The tell is 10%: buildings
 * other than residential and furniture and fittings are both written down at
 * that rate and are two separate blocks, because a building is not furniture.
 * Pooling them gave the same total every year until one of them was sold, and
 * then the proceeds came off the wrong pool.
 *
 * Motor vehicles are not a class of their own — Appendix I puts them inside
 * machinery and plant — so a delivery van and a chest freezer really are one
 * block at 15%, and the entries below say so.
 */
type AssetClass = "BUILDING" | "FURNITURE" | "PLANT" | "INTANGIBLE";

const CLASS_OF: Record<BlockKey, AssetClass> = {
  BUILDING_RESIDENTIAL: "BUILDING",
  BUILDING_OTHER: "BUILDING",
  FURNITURE: "FURNITURE",
  PLANT_MACHINERY: "PLANT",
  MOTOR_VEHICLE: "PLANT",
  COMPUTER: "PLANT",
  INTANGIBLE: "INTANGIBLE",
};

export function blockByKey(key: BlockKey): Block {
  const found = BLOCKS.find((block) => block.key === key);
  // Every key in the union has an entry; the fallback keeps the type honest.
  return found ?? BLOCKS[BLOCKS.length - 1]!;
}

/**
 * Guesses a block from what the asset is called.
 *
 * Longest keyword wins, so "delivery vehicle" is a vehicle rather than being
 * caught by a shorter word elsewhere. A guess is still a guess: the working
 * paper prints the block it chose next to every asset.
 */
export function inferBlock(
  ...text: Array<string | null | undefined>
): BlockKey {
  const haystack = text.filter(Boolean).join(" ").toLowerCase();
  if (!haystack.trim()) return DEFAULT_BLOCK;

  let best: { key: BlockKey; length: number } | null = null;
  for (const block of BLOCKS) {
    for (const keyword of block.keywords) {
      if (
        haystack.includes(keyword) &&
        (best === null || keyword.length > best.length)
      ) {
        best = { key: block.key, length: keyword.length };
      }
    }
  }
  return best?.key ?? DEFAULT_BLOCK;
}

export type AssetInput = {
  id: string;
  name: string;
  /** Free text from the asset register; used to infer a block. */
  category?: string | null;
  purchaseDate: Date;
  purchaseCost: MoneyInput;
  /**
   * A rate recorded against the asset itself. Anything above zero is taken as
   * deliberate and overrides the guess.
   */
  ratePercent?: MoneyInput;
  disposedAt?: Date | null;
  /** Money receivable on the sale. Comes off the block, not off the asset. */
  disposalValue?: MoneyInput;
};

export type AssetPlacement = {
  id: string;
  name: string;
  blockKey: BlockKey;
  blockLabel: string;
  ratePercent: number;
  /** True when the rate was guessed from the asset's category rather than set. */
  rateInferred: boolean;
  purchaseDate: string;
  purchaseCost: Decimal;
  /** Bought during the year being computed. */
  addedThisYear: boolean;
  /** Bought this year and in use for under 180 days, so at half the rate. */
  halfRate: boolean;
  disposedThisYear: boolean;
};

export type BlockDepreciation = {
  /**
   * What the block is called. A block under the Act is a class of assets at a
   * prescribed rate, and the class is what the pooling turns on; this label is
   * descriptive within that — taken from what most of the assets in it appear
   * to be, since one class can hold several of the kinds `BLOCKS` names.
   */
  label: string;
  ratePercent: number;
  openingWdv: Decimal;
  additionsFullRate: Decimal;
  additionsHalfRate: Decimal;
  disposals: Decimal;
  depreciation: Decimal;
  closingWdv: Decimal;
  /** True when proceeds exhausted the block, so no depreciation is allowable. */
  exhausted: boolean;
  assets: AssetPlacement[];
};

export type DepreciationSchedule = {
  blocks: BlockDepreciation[];
  openingWdv: Decimal;
  additions: Decimal;
  disposals: Decimal;
  depreciation: Decimal;
  closingWdv: Decimal;
  /** Things a person needs to know before relying on the figure. */
  notes: string[];
};

const DAY = 86_400_000;

/** Days an asset was held in a year, counting the day it was bought. */
function daysHeld(purchaseDate: Date, windowEnd: Date): number {
  return Math.floor((windowEnd.getTime() - purchaseDate.getTime()) / DAY) + 1;
}

/** The number of days that makes the difference between full and half rate. */
export const HALF_RATE_DAYS = 180;

function within(date: Date, from: Date, to: Date): boolean {
  return date.getTime() >= from.getTime() && date.getTime() <= to.getTime();
}

/**
 * Every year from the one containing the earliest asset up to the target year.
 *
 * A block balance is a running total, so the year being reported on cannot be
 * computed without walking the years before it. Windows are anchored to the
 * target year's own start date, which is how a company with a non-April year
 * end gets the right boundaries without a second calendar.
 */
function yearWindows(
  earliest: Date,
  target: { from: Date; to: Date },
): Array<{ from: Date; to: Date }> {
  const windows: Array<{ from: Date; to: Date }> = [target];

  let from = target.from;
  let to = target.to;
  // A guard rather than a condition: an asset dated far in the past would
  // otherwise spin here, and a hundred years of roll-forward is plenty.
  for (let i = 0; i < 100 && earliest.getTime() < from.getTime(); i += 1) {
    to = new Date(from.getTime() - DAY);
    from = new Date(
      Date.UTC(
        from.getUTCFullYear() - 1,
        from.getUTCMonth(),
        from.getUTCDate(),
      ),
    );
    windows.unshift({ from, to });
  }

  return windows;
}

type Running = { wdv: Decimal; live: number };

type PlacedAsset = {
  asset: AssetInput;
  inferredKey: BlockKey;
  ratePercent: number;
  rateInferred: boolean;
};

/**
 * What to call a block, once its members are settled.
 *
 * Whatever most of them look like, provided that guess carries the same rate.
 * A shop whose delivery van and chest freezer are both machinery and plant at
 * 15% gets a name for that block rather than a bare percentage.
 */
function labelForRate(members: readonly PlacedAsset[], rate: number): string {
  const counts = new Map<BlockKey, number>();
  for (const member of members) {
    if (blockByKey(member.inferredKey).ratePercent !== rate) continue;
    counts.set(member.inferredKey, (counts.get(member.inferredKey) ?? 0) + 1);
  }

  let best: { key: BlockKey; count: number } | null = null;
  for (const [key, count] of counts) {
    if (best === null || count > best.count) best = { key, count };
  }
  if (best) return blockByKey(best.key).label;

  const byRate = BLOCKS.find((block) => block.ratePercent === rate);
  return byRate ? byRate.label : `Assets depreciated at ${rate}%`;
}

export function computeDepreciation(params: {
  assets: readonly AssetInput[];
  /** The year being reported on, inclusive at both ends. */
  from: Date;
  to: Date;
}): DepreciationSchedule {
  const notes: string[] = [];

  const placed: PlacedAsset[] = params.assets.map((asset) => {
    const declared = money(asset.ratePercent ?? 0);
    const inferredKey = inferBlock(asset.category, asset.name);
    const useDeclared = compare(declared, 0) > 0;

    return {
      asset,
      inferredKey,
      // A rate recorded against the asset is taken as deliberate; otherwise the
      // block guessed from its name supplies one.
      ratePercent: useDeclared
        ? declared.toNumber()
        : blockByKey(inferredKey).ratePercent,
      rateInferred: !useDeclared,
    };
  });

  // Pooled by class and rate together, because that is what a block is. Two
  // assets the register calls different things but that share a class and a
  // percentage are one block under the Act, and keeping them apart would give
  // the wrong answer as soon as one of them is sold. Two that share only the
  // percentage are not, and pooling them is wrong the same way for the same
  // reason — see `CLASS_OF`.
  const pools = new Map<string, PlacedAsset[]>();
  for (const entry of placed) {
    const key = `${CLASS_OF[entry.inferredKey]}:${entry.ratePercent}`;
    pools.set(key, [...(pools.get(key) ?? []), entry]);
  }

  const blocks: BlockDepreciation[] = [];

  for (const members of pools.values()) {
    const first = members[0];
    if (!first) continue;
    const ratePercent = first.ratePercent;
    const label = labelForRate(members, ratePercent);

    const earliest = members.reduce(
      (oldest, entry) =>
        entry.asset.purchaseDate.getTime() < oldest.getTime()
          ? entry.asset.purchaseDate
          : oldest,
      first.asset.purchaseDate,
    );

    let running: Running = { wdv: money(0), live: 0 };
    let reported: BlockDepreciation | null = null;

    for (const window of yearWindows(earliest, {
      from: params.from,
      to: params.to,
    })) {
      const opening = running.wdv;
      let additionsFullRate = money(0);
      let additionsHalfRate = money(0);
      let disposals = money(0);
      let live = running.live;
      const assets: AssetPlacement[] = [];

      for (const entry of members) {
        const { asset } = entry;
        const added = within(asset.purchaseDate, window.from, window.to);
        const disposed =
          asset.disposedAt != null &&
          within(asset.disposedAt, window.from, window.to);
        const halfRate =
          added && daysHeld(asset.purchaseDate, window.to) < HALF_RATE_DAYS;

        if (added) {
          const cost = money(asset.purchaseCost);
          if (halfRate) additionsHalfRate = add(additionsHalfRate, cost);
          else additionsFullRate = add(additionsFullRate, cost);
          live += 1;
        }
        if (disposed) {
          disposals = add(disposals, money(asset.disposalValue ?? 0));
          live -= 1;
        }

        assets.push({
          id: asset.id,
          name: asset.name,
          blockKey: entry.inferredKey,
          blockLabel: blockByKey(entry.inferredKey).label,
          ratePercent: entry.ratePercent,
          rateInferred: entry.rateInferred,
          purchaseDate: asset.purchaseDate.toISOString().slice(0, 10),
          purchaseCost: money(asset.purchaseCost),
          addedThisYear: added,
          halfRate,
          disposedThisYear: disposed,
        });
      }

      // Proceeds come off the block. They eat the full-rate side first, and
      // only what is left over touches the half-rate additions.
      let fullBase = subtract(add(opening, additionsFullRate), disposals);
      let halfBase = additionsHalfRate;
      if (compare(fullBase, 0) < 0) {
        halfBase = add(halfBase, fullBase);
        fullBase = money(0);
      }
      halfBase = max(halfBase, 0);

      // A block with nothing left in it, or one the proceeds have exhausted,
      // gets no depreciation at all.
      const exhausted = live <= 0 || compare(add(fullBase, halfBase), 0) <= 0;

      const depreciation = exhausted
        ? money(0)
        : add(
            percentOf(fullBase, ratePercent),
            percentOf(halfBase, ratePercent / 2),
          );

      const closingWdv = max(
        subtract(add(fullBase, halfBase), depreciation),
        0,
      );

      running = { wdv: closingWdv, live };

      if (window.from.getTime() === params.from.getTime()) {
        reported = {
          label,
          ratePercent,
          openingWdv: opening,
          additionsFullRate,
          additionsHalfRate,
          disposals,
          depreciation,
          closingWdv,
          exhausted,
          assets,
        };
      }
    }

    if (reported) blocks.push(reported);
  }

  blocks.sort(
    (a, b) => b.ratePercent - a.ratePercent || a.label.localeCompare(b.label),
  );

  if (
    blocks.some((block) => block.assets.some((asset) => asset.rateInferred))
  ) {
    notes.push(
      "Some assets were placed in a block by what they are called, because no rate was recorded against them. Check the block and rate on each before relying on the figure.",
    );
  }
  if (blocks.some((block) => block.exhausted)) {
    notes.push(
      "Sale proceeds exhausted a block, so no depreciation is allowable on it this year. What happens to the excess is a capital gains question this working paper does not answer.",
    );
  }
  if (blocks.some((block) => block.assets.some((asset) => asset.halfRate))) {
    notes.push(
      "Assets bought late in the year get half the rate. This uses the purchase date, because that is what the asset register records — if an asset was put to use later than it was bought, the year it first earns depreciation may differ.",
    );
  }

  return {
    blocks,
    openingWdv: add(...blocks.map((block) => block.openingWdv)),
    additions: add(
      ...blocks.map((block) =>
        add(block.additionsFullRate, block.additionsHalfRate),
      ),
    ),
    disposals: add(...blocks.map((block) => block.disposals)),
    depreciation: add(...blocks.map((block) => block.depreciation)),
    closingWdv: add(...blocks.map((block) => block.closingWdv)),
    notes,
  };
}
