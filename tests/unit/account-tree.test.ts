import { describe, expect, it } from "vitest";
import {
  ACCOUNT_TYPE_HINTS,
  ACCOUNT_TYPE_LABELS,
  accountsInSubtree,
  buildAccountTree,
  flattenTree,
  type TreeGroup,
} from "@/lib/accounting/account-tree";
import {
  DEFAULT_ACCOUNTS,
  DEFAULT_ACCOUNT_GROUPS,
} from "@/lib/accounting/chart-of-accounts";
import {
  ACCOUNT_TYPES,
  DEFAULT_GROUP_CODE,
  DEFAULT_SECTION,
  NATURAL_SIDE,
  SELECTABLE_SUBTYPES,
} from "@/lib/validation/accounts";

/**
 * A chart of accounts is user-editable, so the tree builder has to survive
 * charts nobody designed: an orphaned group, a cycle, an account whose group
 * was archived. The rule throughout is that nothing disappears — an account
 * shown at the wrong indent is recoverable, an account silently missing from
 * the balance sheet is not.
 */

const group = (
  id: string,
  code: string,
  parentId: string | null = null,
  sortOrder = 0,
): TreeGroup => ({
  id,
  code,
  name: `Group ${code}`,
  type: "ASSET",
  parentId,
  sortOrder,
});

const account = (id: string, code: string, groupId: string) => ({
  id,
  code,
  name: `Account ${code}`,
  groupId,
});

describe("buildAccountTree", () => {
  it("nests groups under their parents", () => {
    const tree = buildAccountTree(
      [group("a", "1000"), group("b", "1100", "a"), group("c", "1110", "b")],
      [account("x", "1111", "c")],
    );

    expect(tree).toHaveLength(1);
    expect(tree[0]?.group.code).toBe("1000");
    expect(tree[0]?.depth).toBe(0);
    expect(tree[0]?.children[0]?.group.code).toBe("1100");
    expect(tree[0]?.children[0]?.depth).toBe(1);
    expect(tree[0]?.children[0]?.children[0]?.accounts[0]?.code).toBe("1111");
    expect(tree[0]?.children[0]?.children[0]?.depth).toBe(2);
  });

  it("orders siblings by sortOrder then code", () => {
    const tree = buildAccountTree(
      [
        group("c", "3000", null, 30),
        group("a", "1000", null, 10),
        group("b", "2000", null, 10),
      ],
      [],
    );

    expect(tree.map((node) => node.group.code)).toEqual([
      "1000",
      "2000",
      "3000",
    ]);
  });

  it("sorts account codes numerically, not as strings", () => {
    const tree = buildAccountTree(
      [group("a", "1000")],
      [
        account("z", "1120", "a"),
        account("y", "119", "a"),
        account("x", "12", "a"),
      ],
    );

    expect(tree[0]?.accounts.map((entry) => entry.code)).toEqual([
      "12",
      "119",
      "1120",
    ]);
  });

  it("attaches an orphan at the root rather than losing it", () => {
    // The parent does not exist. The account under the orphan must still be
    // reachable — a missing balance sheet line is worse than a wrong indent.
    const tree = buildAccountTree(
      [group("a", "1000"), group("lost", "9900", "does-not-exist")],
      [account("x", "9901", "lost")],
    );

    expect(tree).toHaveLength(2);
    expect(tree.flatMap((node) => accountsInSubtree(node))).toHaveLength(1);
  });

  it("breaks a cycle instead of recursing forever", () => {
    const tree = buildAccountTree(
      [group("a", "1000", "b"), group("b", "2000", "a")],
      [account("x", "1001", "a"), account("y", "2001", "b")],
    );

    const accounts = tree.flatMap((node) => accountsInSubtree(node));
    expect(accounts).toHaveLength(2);
  });

  it("keeps a group that has no accounts", () => {
    // An empty group is where a retailer files their next new account. Hiding
    // it would make the chart look like it has no room in it.
    const tree = buildAccountTree([group("a", "1000")], []);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.accounts).toEqual([]);
  });

  it("drops an account whose group is not in the chart", () => {
    // Nothing to attach it to and nowhere sensible to show it. This is the one
    // case where losing a row is right — the alternative is inventing a group.
    const tree = buildAccountTree(
      [group("a", "1000")],
      [account("x", "1001", "missing")],
    );
    expect(tree[0]?.accounts).toEqual([]);
  });

  it("handles an empty chart", () => {
    expect(buildAccountTree([], [])).toEqual([]);
  });
});

describe("accountsInSubtree", () => {
  it("counts everything beneath a group, not just its own accounts", () => {
    // "Current Assets" holds nothing directly; cash, stock and receivables all
    // hang off child groups. A total that ignored them would report zero.
    const tree = buildAccountTree(
      [group("a", "1100"), group("b", "1110", "a"), group("c", "1120", "a")],
      [account("x", "1111", "b"), account("y", "1121", "c")],
    );

    expect(accountsInSubtree(tree[0]!)).toHaveLength(2);
  });
});

describe("flattenTree", () => {
  it("walks depth-first so rows render in reading order", () => {
    const tree = buildAccountTree(
      [
        group("a", "1000", null, 10),
        group("b", "1100", "a"),
        group("c", "2000", null, 20),
      ],
      [],
    );

    expect(flattenTree(tree).map((node) => node.group.code)).toEqual([
      "1000",
      "1100",
      "2000",
    ]);
  });
});

describe("the seeded chart", () => {
  it("builds into a tree with every account reachable", () => {
    const groups: TreeGroup[] = DEFAULT_ACCOUNT_GROUPS.map((seed) => ({
      id: seed.code,
      code: seed.code,
      name: seed.name,
      type: seed.type,
      parentId: seed.parentCode ?? null,
      sortOrder: seed.sortOrder,
    }));

    const accounts = DEFAULT_ACCOUNTS.map((seed) => ({
      id: seed.code,
      code: seed.code,
      name: seed.name,
      groupId: seed.groupCode,
    }));

    const tree = buildAccountTree(groups, accounts);
    const reachable = tree.flatMap((node) => accountsInSubtree(node));

    expect(reachable).toHaveLength(DEFAULT_ACCOUNTS.length);
    // Five roots: one per account type.
    expect(tree.map((node) => node.group.code).slice(0, 3)).toEqual([
      "1000",
      "2000",
      "3000",
    ]);
  });

  it("gives every account a group that exists", () => {
    const codes = new Set(DEFAULT_ACCOUNT_GROUPS.map((entry) => entry.code));
    for (const seed of DEFAULT_ACCOUNTS) {
      expect(codes.has(seed.groupCode), `${seed.code} ${seed.name}`).toBe(true);
    }
  });

  it("files every account under a group of its own type", () => {
    const groupType = new Map(
      DEFAULT_ACCOUNT_GROUPS.map((entry) => [entry.code, entry.type]),
    );
    for (const seed of DEFAULT_ACCOUNTS) {
      expect(groupType.get(seed.groupCode), `${seed.code} ${seed.name}`).toBe(
        seed.type,
      );
    }
  });

  it("uses each code exactly once", () => {
    const codes = DEFAULT_ACCOUNTS.map((entry) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("what a retailer may add", () => {
  it("offers a sub-type for every type", () => {
    for (const type of ACCOUNT_TYPES) {
      expect(SELECTABLE_SUBTYPES[type].length).toBeGreaterThan(0);
      expect(NATURAL_SIDE[type]).toMatch(/^(DEBIT|CREDIT)$/);
      expect(DEFAULT_SECTION[type]).toBeTruthy();
      expect(ACCOUNT_TYPE_LABELS[type]).toBeTruthy();
      expect(ACCOUNT_TYPE_HINTS[type]).toBeTruthy();
    }
  });

  it("never offers a sub-type reserved for the engine", () => {
    // Retained earnings and accumulated depreciation exist so the closing and
    // depreciation routines can find them, not so somebody can make a second.
    const offered = ACCOUNT_TYPES.flatMap((type) =>
      SELECTABLE_SUBTYPES[type].map((option) => option.value),
    );
    expect(offered).not.toContain("RETAINED_EARNINGS");
    expect(offered).not.toContain("INVENTORY");
    expect(offered).not.toContain("RECEIVABLE");
    expect(offered).not.toContain("PAYABLE");
  });

  it("puts assets and expenses on the debit side, the rest on credit", () => {
    expect(NATURAL_SIDE.ASSET).toBe("DEBIT");
    expect(NATURAL_SIDE.EXPENSE).toBe("DEBIT");
    expect(NATURAL_SIDE.LIABILITY).toBe("CREDIT");
    expect(NATURAL_SIDE.EQUITY).toBe("CREDIT");
    expect(NATURAL_SIDE.INCOME).toBe("CREDIT");
  });

  it("knows where to file every sub-type it offers", () => {
    // Without this the dialog would open with an empty "Filed under" and the
    // only way to find out is a failed submit.
    const groupCodes = new Set(
      DEFAULT_ACCOUNT_GROUPS.map((entry) => entry.code),
    );
    for (const type of ACCOUNT_TYPES) {
      for (const option of SELECTABLE_SUBTYPES[type]) {
        const code = DEFAULT_GROUP_CODE[option.value];
        expect(code, `${type}/${option.value}`).toBeTruthy();
        expect(groupCodes.has(code!), `${option.value} → ${code}`).toBe(true);
      }
    }
  });

  it("files each sub-type under a group of its own type", () => {
    const groupType = new Map(
      DEFAULT_ACCOUNT_GROUPS.map((entry) => [entry.code, entry.type]),
    );
    for (const type of ACCOUNT_TYPES) {
      for (const option of SELECTABLE_SUBTYPES[type]) {
        const code = DEFAULT_GROUP_CODE[option.value];
        expect(groupType.get(code!), `${option.value} → ${code}`).toBe(type);
      }
    }
  });

  it("explains every option it offers", () => {
    for (const type of ACCOUNT_TYPES) {
      for (const option of SELECTABLE_SUBTYPES[type]) {
        expect(option.label.length).toBeGreaterThan(2);
        expect(option.hint.length).toBeGreaterThan(10);
      }
    }
  });
});
