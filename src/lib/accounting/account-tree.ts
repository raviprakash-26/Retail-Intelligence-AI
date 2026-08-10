import type { AccountType } from "@prisma/client";

/**
 * Turning a flat chart of accounts into the shape an accountant reads.
 *
 * Pure, so it can be unit-tested against odd charts — an orphaned group, a
 * cycle, an account whose group was archived — without a database. A chart of
 * accounts is user-editable, and the day someone renumbers a group is not the
 * day the page should throw.
 */

export type TreeGroup = {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  parentId: string | null;
  sortOrder: number;
};

export type TreeAccount = {
  id: string;
  code: string;
  name: string;
  groupId: string;
};

export type AccountTreeNode<TAccount extends TreeAccount> = {
  group: TreeGroup;
  accounts: TAccount[];
  children: Array<AccountTreeNode<TAccount>>;
  /** Nesting depth, so the view can indent without walking back up. */
  depth: number;
};

const byCode = (a: { code: string }, b: { code: string }) =>
  a.code.localeCompare(b.code, undefined, { numeric: true });

/**
 * Builds the group tree with each group's own accounts hanging off it.
 *
 * Groups whose parent is missing — archived, or deleted out from under them —
 * are attached at the root rather than dropped. An account that vanishes from
 * the chart because of a broken parent link is far worse than one that appears
 * at the wrong indent level, and the second is at least visibly wrong.
 *
 * A cycle is broken the same way: any group that cannot reach a root within the
 * number of groups that exist is treated as a root itself.
 */
export function buildAccountTree<TAccount extends TreeAccount>(
  groups: readonly TreeGroup[],
  accounts: readonly TAccount[],
): Array<AccountTreeNode<TAccount>> {
  const accountsByGroup = new Map<string, TAccount[]>();
  for (const account of accounts) {
    const existing = accountsByGroup.get(account.groupId);
    if (existing) existing.push(account);
    else accountsByGroup.set(account.groupId, [account]);
  }

  const known = new Set(groups.map((group) => group.id));

  /** Whether following `parentId` from here terminates at a root. */
  const reachesRoot = (group: TreeGroup): boolean => {
    const seen = new Set<string>([group.id]);
    let parentId = group.parentId;
    while (parentId) {
      if (seen.has(parentId) || !known.has(parentId)) return false;
      seen.add(parentId);
      parentId =
        groups.find((entry) => entry.id === parentId)?.parentId ?? null;
    }
    return true;
  };

  const nodes = new Map<string, AccountTreeNode<TAccount>>(
    groups.map((group) => [
      group.id,
      {
        group,
        accounts: (accountsByGroup.get(group.id) ?? []).sort(byCode),
        children: [],
        depth: 0,
      },
    ]),
  );

  const roots: Array<AccountTreeNode<TAccount>> = [];
  for (const group of groups) {
    const node = nodes.get(group.id);
    if (!node) continue;

    const parent = group.parentId ? nodes.get(group.parentId) : undefined;
    if (parent && reachesRoot(group)) parent.children.push(node);
    else roots.push(node);
  }

  const order = (
    list: Array<AccountTreeNode<TAccount>>,
    depth: number,
  ): Array<AccountTreeNode<TAccount>> =>
    list
      .sort(
        (a, b) =>
          a.group.sortOrder - b.group.sortOrder || byCode(a.group, b.group),
      )
      .map((node) => ({
        ...node,
        depth,
        children: order(node.children, depth + 1),
      }));

  return order(roots, 0);
}

/** Depth-first walk, so a view can render a tree as flat rows. */
export function flattenTree<TAccount extends TreeAccount>(
  nodes: ReadonlyArray<AccountTreeNode<TAccount>>,
): Array<AccountTreeNode<TAccount>> {
  return nodes.flatMap((node) => [node, ...flattenTree(node.children)]);
}

/**
 * Accounts under a group and everything beneath it.
 *
 * A group total that counted only its own direct accounts would report
 * "Current Assets: ₹0" for a business with cash, stock and receivables, because
 * each of those hangs off a child group.
 */
export function accountsInSubtree<TAccount extends TreeAccount>(
  node: AccountTreeNode<TAccount>,
): TAccount[] {
  return [
    ...node.accounts,
    ...node.children.flatMap((child) => accountsInSubtree(child)),
  ];
}

/** The label an account type carries in the interface. */
export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  ASSET: "Assets",
  LIABILITY: "Liabilities",
  EQUITY: "Capital",
  INCOME: "Income",
  EXPENSE: "Expenses",
};

/**
 * What each type means, in the words a shopkeeper would use.
 *
 * The chart of accounts is the one screen where a retailer meets bookkeeping
 * vocabulary head-on. Naming the five types without explaining them teaches
 * nobody anything.
 */
export const ACCOUNT_TYPE_HINTS: Record<AccountType, string> = {
  ASSET:
    "What the business owns or is owed — cash, stock, money customers owe.",
  LIABILITY: "What the business owes — suppliers, loans, tax collected.",
  EQUITY: "Your stake: what you put in, what you took out, what was earned.",
  INCOME: "What the business earns — sales and anything else that comes in.",
  EXPENSE: "What it costs to run and to buy what you sell.",
};
