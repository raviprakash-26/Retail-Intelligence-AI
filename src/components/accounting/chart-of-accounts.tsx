"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Lock,
  Pencil,
  Plus,
  Search,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  accountsInSubtree,
  ACCOUNT_TYPE_LABELS,
  type AccountTreeNode,
} from "@/lib/accounting/account-tree";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  ChartAccount,
  ChartGroup,
} from "@/server/accounting/account-service";
import { setAccountActiveAction } from "@/server/accounting/actions";
import { AccountDialog } from "./account-dialog";

/**
 * The chart of accounts.
 *
 * Shown as the tree it is, because the structure carries meaning: Cash sits
 * under Cash & Bank, which sits under Current Assets, which is why it appears
 * where it does on the balance sheet. A flat alphabetical list would be easier
 * to build and would teach nobody anything about their own books.
 *
 * Group totals include everything beneath them, so "Current Assets" is the
 * figure that will appear on the balance sheet rather than the sum of whatever
 * happens to hang directly off that one node.
 */
export function ChartOfAccounts({
  tree,
  groups,
  counts,
  canManage,
  showInactive,
}: {
  tree: Array<AccountTreeNode<ChartAccount>>;
  groups: ChartGroup[];
  counts: { total: number; custom: number; inactive: number };
  canManage: boolean;
  showInactive: boolean;
}) {
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ChartAccount | null>(null);

  const term = query.trim().toLowerCase();

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            name="account-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name or code"
            className="pl-9"
          />
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const url = new URL(window.location.href);
              if (showInactive) url.searchParams.delete("inactive");
              else url.searchParams.set("inactive", "1");
              router.push(`${url.pathname}${url.search}`);
            }}
          >
            {showInactive ? "Hide retired" : "Show retired"}
            {counts.inactive > 0 && (
              <Badge variant="muted" className="ml-1">
                {counts.inactive}
              </Badge>
            )}
          </Button>

          {canManage && (
            <Button
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="size-4" />
              New account
            </Button>
          )}
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border">
        {tree.map((node) => (
          <GroupNode
            key={node.group.id}
            node={node}
            term={term}
            canManage={canManage}
            onEdit={(account) => {
              setEditing(account);
              setDialogOpen(true);
            }}
          />
        ))}
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        {counts.total} accounts, {counts.custom} of them yours. The rest are the
        ones the system posts to automatically — you can rename any of them, but
        they cannot be removed, because the rules that record your sales,
        purchases and tax all resolve them by an identifier that never changes.
      </p>

      <AccountDialog
        open={dialogOpen}
        account={editing}
        groups={groups}
        onClose={() => setDialogOpen(false)}
      />
    </div>
  );
}

function GroupNode({
  node,
  term,
  canManage,
  onEdit,
}: {
  node: AccountTreeNode<ChartAccount>;
  term: string;
  canManage: boolean;
  onEdit: (account: ChartAccount) => void;
}) {
  const all = accountsInSubtree(node);

  const matches = (account: ChartAccount) =>
    term.length === 0 ||
    account.name.toLowerCase().includes(term) ||
    account.code.toLowerCase().includes(term);

  // A group with nothing matching disappears entirely rather than showing an
  // empty heading: searching "rent" should produce one row, not the skeleton of
  // a chart with one row in it.
  if (!all.some(matches)) return null;

  const total = all.reduce((sum, account) => sum + Number(account.balance), 0);
  const visible = node.accounts.filter(matches);

  return (
    <>
      <div
        className={cn(
          "flex items-center justify-between gap-3 border-b bg-secondary/40 px-4 py-2",
          node.depth > 0 && "bg-secondary/20",
        )}
        style={{ paddingLeft: `${1 + node.depth * 1.25}rem` }}
      >
        <span className="flex min-w-0 items-center gap-2">
          {node.depth > 0 && (
            <ChevronRight
              className="size-3 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          )}
          <span className="truncate font-mono text-xs text-muted-foreground">
            {node.group.code}
          </span>
          <span
            className={cn(
              "truncate text-sm",
              node.depth === 0 ? "font-semibold" : "font-medium",
            )}
          >
            {node.group.name}
          </span>
          {node.depth === 0 && (
            <Badge variant="muted" className="hidden sm:inline-flex">
              {ACCOUNT_TYPE_LABELS[node.group.type]}
            </Badge>
          )}
        </span>
        {total !== 0 && (
          <span className="tabular-figures shrink-0 text-sm font-medium">
            {formatCurrency(total, { compactZeroDecimals: true })}
          </span>
        )}
      </div>

      {visible.map((account) => (
        <AccountRow
          key={account.id}
          account={account}
          depth={node.depth}
          canManage={canManage}
          onEdit={onEdit}
        />
      ))}

      {node.children.map((child) => (
        <GroupNode
          key={child.group.id}
          node={child}
          term={term}
          canManage={canManage}
          onEdit={onEdit}
        />
      ))}
    </>
  );
}

/**
 * Hidden until hovered where hovering is possible, always shown where it is
 * not. A control that only appears on hover does not appear at all on a phone.
 */
const REVEAL_ON_HOVER =
  "transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100";

function AccountRow({
  account,
  depth,
  canManage,
  onEdit,
}: {
  account: ChartAccount;
  depth: number;
  canManage: boolean;
  onEdit: (account: ChartAccount) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const balance = Number(account.balance);

  async function toggleActive() {
    setBusy(true);
    setError(null);
    try {
      const result = await setAccountActiveAction(
        account.id,
        !account.isActive,
      );
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={cn(
        "group flex items-center justify-between gap-3 border-b px-4 py-2 last:border-b-0",
        !account.isActive && "opacity-55",
      )}
      style={{ paddingLeft: `${1.75 + depth * 1.25}rem` }}
    >
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {account.code}
          </span>
          <span className="truncate text-sm">{account.name}</span>
          {account.isSystem && (
            <Lock
              className="size-3 shrink-0 text-muted-foreground"
              aria-label="Posted to automatically"
            />
          )}
          {!account.isActive && <Badge variant="muted">Retired</Badge>}
        </span>
        {error && (
          <span className="mt-0.5 text-xs text-destructive">{error}</span>
        )}
      </span>

      <span className="flex shrink-0 items-center gap-1">
        {balance !== 0 && (
          <span className="tabular-figures mr-1 text-sm">
            {formatCurrency(balance, { compactZeroDecimals: true })}
          </span>
        )}

        {canManage && (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onEdit(account)}
              aria-label={`Rename ${account.name}`}
              className={REVEAL_ON_HOVER}
            >
              <Pencil className="size-3.5" />
            </Button>

            {!account.isSystem && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={toggleActive}
                disabled={busy}
                aria-label={
                  account.isActive
                    ? `Put ${account.name} away`
                    : `Bring ${account.name} back`
                }
                className={REVEAL_ON_HOVER}
              >
                {account.isActive ? (
                  <Archive className="size-3.5" />
                ) : (
                  <ArchiveRestore className="size-3.5" />
                )}
              </Button>
            )}
          </>
        )}
      </span>
    </div>
  );
}
