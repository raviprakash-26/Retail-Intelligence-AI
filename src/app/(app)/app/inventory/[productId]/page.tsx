import type { Metadata } from "next";
import Link from "next/link";
import type { Route } from "next";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { ListPagination } from "@/components/master-data/list-toolbar";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatDate, formatNumber } from "@/lib/format";
import { requirePermission } from "@/server/auth/context";
import {
  getProductStockCard,
  InventoryReportError,
} from "@/server/inventory/inventory-report";

export const metadata: Metadata = {
  title: "Stock card",
  robots: { index: false, follow: false },
};

/**
 * One product's whole history.
 *
 * Every movement in date order with the balance after it, and a link to the
 * document that caused each — the inventory equivalent of a ledger. "Where did
 * forty packets go" is answerable on this page and nowhere else.
 */
export default async function StockCardPage({
  params,
  searchParams,
}: {
  params: Promise<{ productId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await requirePermission("inventory.view");
  const { productId } = await params;
  const search = await searchParams;
  const rawPage = Array.isArray(search.page) ? search.page[0] : search.page;

  const card = await getProductStockCard({
    companyId: context.company.id,
    productId,
    page: Number(rawPage ?? 1) || 1,
  }).catch((error: unknown) => {
    if (error instanceof InventoryReportError) notFound();
    throw error;
  });

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <Link
        href="/app/inventory"
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        <ArrowLeft className="size-3.5" />
        Inventory
      </Link>

      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {card.product.name}
          </h1>
          <p className="mt-1 font-mono text-sm text-muted-foreground">
            {card.product.sku}
          </p>
        </div>
        <div className="rounded-lg border px-4 py-2.5 text-right">
          <p className="text-xs text-muted-foreground">On hand</p>
          <p className="tabular-figures text-lg font-semibold">
            {formatNumber(card.quantity)}
            <span className="ml-1 text-xs font-normal text-muted-foreground">
              {card.product.unitCode}
            </span>
          </p>
        </div>
      </header>

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Tile
          label="Value at cost"
          value={formatCurrency(card.stockValue, { compactZeroDecimals: true })}
        />
        <Tile label="Average cost" value={formatCurrency(card.averageCost)} />
        <Tile
          label="Selling price"
          value={formatCurrency(card.product.sellingPrice)}
        />
      </div>

      {card.movements.length === 0 ? (
        <div className="rounded-xl border border-dashed px-6 py-14 text-center">
          <h2 className="text-base font-semibold">Nothing has moved yet</h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
            This product has no stock history. Record a bill to bring some in.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table className="border-0">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Date</TableHead>
                <TableHead>What happened</TableHead>
                <TableHead className="text-right">In / out</TableHead>
                <TableHead className="text-right">Cost each</TableHead>
                <TableHead className="pr-4 text-right">Left</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {card.movements.map((movement) => {
                const quantity = Number(movement.quantity);
                return (
                  <TableRow key={movement.id}>
                    <TableCell className="pl-4 align-top text-xs whitespace-nowrap text-muted-foreground">
                      {formatDate(movement.date, { style: "short" })}
                    </TableCell>
                    <TableCell className="align-top">
                      <Badge variant="muted">{movement.typeLabel}</Badge>
                      {movement.notes && (
                        <p className="mt-0.5 max-w-md text-xs text-muted-foreground">
                          {movement.notes}
                        </p>
                      )}
                      {movement.documentHref && (
                        <Link
                          href={movement.documentHref as Route}
                          className="mt-0.5 inline-flex items-center gap-0.5 text-xs text-primary underline-offset-4 hover:underline"
                        >
                          Open the document
                          <ArrowUpRight className="size-3" />
                        </Link>
                      )}
                    </TableCell>
                    <TableCell className="tabular-figures text-right align-top text-sm">
                      <span
                        className={
                          quantity < 0
                            ? "text-destructive"
                            : "text-success-foreground"
                        }
                      >
                        {quantity > 0 ? "+" : ""}
                        {formatNumber(movement.quantity)}
                      </span>
                    </TableCell>
                    <TableCell className="tabular-figures text-right align-top text-sm">
                      {Number(movement.unitCost) === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        formatCurrency(movement.unitCost)
                      )}
                    </TableCell>
                    <TableCell className="tabular-figures pr-4 text-right align-top text-sm font-medium">
                      {formatNumber(movement.balanceQuantity)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="mt-5">
        <ListPagination
          page={card.page}
          pageCount={card.pageCount}
          total={card.total}
          noun="movement"
        />
      </div>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="tabular-figures mt-0.5 text-lg font-semibold">{value}</p>
    </div>
  );
}
