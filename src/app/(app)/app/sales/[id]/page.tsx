import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Ban, FileText } from "lucide-react";
import { VoidDocumentDialog } from "@/components/documents/void-document-dialog";
import { SalesReturnButton } from "@/components/returns/return-buttons";
import { ReturnsAgainstCard } from "@/components/returns/returns-against-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { findStateByCode } from "@/lib/constants/india";
import { formatCurrency, formatDate, formatNumber } from "@/lib/format";
import {
  describeSupplyType,
  type GstRegistration,
  type SupplyType,
} from "@/lib/tax/gst";
import { requirePermission } from "@/server/auth/context";
import { getSale } from "@/server/sales/sale-service";
import { voidSaleAction } from "@/server/sales/actions";
import { returnableLines } from "@/server/returns/sales-return-service";
import { salesReturnsAgainst } from "@/server/returns/return-queries";
import { MasterDataError } from "@/server/master-data/errors";

export const metadata: Metadata = {
  title: "Invoice",
  robots: { index: false, follow: false },
};

/**
 * One invoice, and the entry it produced.
 *
 * The journal entry is shown on the same page as the document rather than being
 * buried in an accounting module. A retailer who can see that a ₹1,180 sale
 * became ₹1,000 of revenue, ₹180 of GST and ₹720 of cost has been taught more
 * about their own books than any explanation would manage.
 */
export default async function SaleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const context = await requirePermission("sales.view");
  const { id } = await params;

  const detail = await getSale({
    companyId: context.company.id,
    saleId: id,
  }).catch((error: unknown) => {
    if (error instanceof MasterDataError) notFound();
    throw error;
  });

  const { sale, entry } = detail;
  const voided = sale.status === "VOIDED";
  const taxNotice = describeSupplyType(
    sale.supplyType as SupplyType,
    context.company.gstRegistration as GstRegistration,
  );

  const mayReturn = !voided && context.permissions.has("sales.return");
  const [returnable, returns] = await Promise.all([
    mayReturn
      ? returnableLines({ companyId: context.company.id, saleId: sale.id })
      : Promise.resolve([]),
    salesReturnsAgainst({ companyId: context.company.id, saleId: sale.id }),
  ]);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <Link
        href="/app/sales"
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        <ArrowLeft className="size-3.5" />
        All invoices
      </Link>

      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex flex-wrap items-center gap-2.5 text-2xl font-semibold tracking-tight">
            <span className={voided ? "line-through" : undefined}>
              {sale.invoiceNumber}
            </span>
            {voided ? (
              <Badge variant="danger">
                <Ban className="size-3" />
                Voided
              </Badge>
            ) : (
              <Badge variant="success">Posted</Badge>
            )}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatDate(sale.invoiceDate, { style: "long" })} ·{" "}
            {sale.customer?.name ?? "Counter sale"}
            {sale.branch ? ` · ${sale.branch.name}` : ""}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {/* The document the customer takes away. A shop that can record a
              sale but cannot issue a bill for it is only half a billing
              product, and a registered supplier is required to issue one. */}
          <Button asChild variant="outline">
            <Link href={`/app/sales/${sale.id}/invoice`}>
              <FileText aria-hidden="true" />
              Tax invoice
            </Link>
          </Button>
          {mayReturn && returnable.length > 0 && (
            <SalesReturnButton
              documentId={sale.id}
              documentNumber={sale.invoiceNumber}
              documentDate={sale.invoiceDate.toISOString().slice(0, 10)}
              hasParty={Boolean(sale.customer)}
              lines={returnable}
            />
          )}
          {!voided && context.permissions.has("sales.void") && (
            <VoidDocumentDialog
              documentId={sale.id}
              documentNumber={sale.invoiceNumber}
              noun="invoice"
              onVoid={voidSaleAction}
            />
          )}
        </div>
      </header>

      {voided && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>This invoice was voided</AlertTitle>
          <AlertDescription>
            {sale.voidReason}
            {sale.voidedAt
              ? ` — ${formatDate(sale.voidedAt, { style: "long" })}`
              : ""}
            . The original entry and the reversal that cancels it both remain in
            the ledger.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Items</CardTitle>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              <Table className="border-0">
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">Item</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Rate</TableHead>
                    <TableHead className="text-right">Taxable</TableHead>
                    <TableHead className="text-right">GST</TableHead>
                    <TableHead className="pr-6 text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sale.items.map((item) => (
                    <TableRow key={item.lineNumber}>
                      <TableCell className="pl-6">
                        <p className="font-medium">
                          {item.description ?? item.product.name}
                        </p>
                        <p className="font-mono text-xs text-muted-foreground">
                          {item.product.sku}
                          {item.hsnCode ? ` · HSN ${item.hsnCode}` : ""}
                        </p>
                      </TableCell>
                      <TableCell className="tabular-figures text-right">
                        {formatNumber(item.quantity)}
                        <span className="ml-1 text-xs text-muted-foreground">
                          {item.product.unit.code}
                        </span>
                      </TableCell>
                      <TableCell className="tabular-figures text-right">
                        {formatCurrency(item.rate, {
                          compactZeroDecimals: true,
                        })}
                        {Number(item.discountPercent) > 0 && (
                          <span className="block text-xs text-muted-foreground">
                            −{Number(item.discountPercent)}%
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="tabular-figures text-right">
                        {formatCurrency(item.taxableAmount)}
                      </TableCell>
                      <TableCell className="tabular-figures text-right">
                        {Number(item.taxPercent) === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <>
                            {formatCurrency(
                              Number(item.cgstAmount) +
                                Number(item.sgstAmount) +
                                Number(item.igstAmount),
                            )}
                            <span className="block text-xs text-muted-foreground">
                              {Number(item.taxPercent)}%
                            </span>
                          </>
                        )}
                      </TableCell>
                      <TableCell className="tabular-figures pr-6 text-right font-medium">
                        {formatCurrency(item.lineTotal)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {entry && (
            <Card>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2">
                  Journal entry {entry.entryNumber}
                  {entry.status === "REVERSED" && (
                    <Badge variant="muted">Reversed</Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="px-0 pb-0">
                <Table className="border-0">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-6">Account</TableHead>
                      <TableHead className="text-right">Debit</TableHead>
                      <TableHead className="pr-6 text-right">Credit</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {entry.lines.map((line) => (
                      <TableRow key={line.lineNumber}>
                        <TableCell className="pl-6">
                          <p className="text-sm">{line.account.name}</p>
                          <p className="font-mono text-xs text-muted-foreground">
                            {line.account.code}
                          </p>
                        </TableCell>
                        <TableCell className="tabular-figures text-right">
                          {Number(line.debit) === 0 ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            formatCurrency(line.debit)
                          )}
                        </TableCell>
                        <TableCell className="tabular-figures pr-6 text-right">
                          {Number(line.credit) === 0 ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            formatCurrency(line.credit)
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <p className="border-t px-6 py-3 text-xs leading-relaxed text-muted-foreground">
                  Debits equal credits at {formatCurrency(entry.totalDebit)}.
                  {Number(sale.costOfGoodsSold) > 0 && (
                    <>
                      {" "}
                      That is more than the {formatCurrency(
                        sale.totalAmount,
                      )}{" "}
                      invoiced because the entry also moves{" "}
                      {formatCurrency(sale.costOfGoodsSold)} of stock into cost
                      of sales — the sale and what it cost you belong together.
                    </>
                  )}{" "}
                  This entry is what the ledger, trial balance and financial
                  statements are built from; the invoice above is the document
                  that caused it.
                </p>
              </CardContent>
            </Card>
          )}

          <ReturnsAgainstCard
            kind="sales"
            rows={returns.rows}
            total={returns.total}
            documentNoun="invoice"
          />
        </div>

        <div className="space-y-6">
          <Card>
            <CardContent className="space-y-2 py-5 text-sm">
              <Row label="Taxable value" value={sale.taxableAmount} />
              {Number(sale.discountAmount) > 0 && (
                <Row label="Discount" value={sale.discountAmount} muted />
              )}
              {Number(sale.cgstAmount) > 0 && (
                <Row label="CGST" value={sale.cgstAmount} muted />
              )}
              {Number(sale.sgstAmount) > 0 && (
                <Row label="SGST" value={sale.sgstAmount} muted />
              )}
              {Number(sale.igstAmount) > 0 && (
                <Row label="IGST" value={sale.igstAmount} muted />
              )}
              {Number(sale.roundOff) !== 0 && (
                <Row label="Round off" value={sale.roundOff} muted />
              )}
              <div className="flex items-baseline justify-between border-t pt-3">
                <span className="font-medium">Total</span>
                <span className="tabular-figures text-lg font-semibold">
                  {formatCurrency(sale.totalAmount)}
                </span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-3 py-5 text-sm">
              <Detail label="Payment" value={sale.paymentMode.toLowerCase()} />
              <Detail
                label="Place of supply"
                value={
                  sale.placeOfSupply
                    ? (findStateByCode(sale.placeOfSupply)?.name ??
                      sale.placeOfSupply)
                    : "—"
                }
              />
              <Detail
                label="Tax treatment"
                value={
                  sale.supplyType === "INTRA_STATE"
                    ? "CGST + SGST"
                    : sale.supplyType === "INTER_STATE"
                      ? "IGST"
                      : "No GST"
                }
              />
              {sale.customer?.gstin && (
                <Detail
                  label="Customer GSTIN"
                  value={sale.customer.gstin}
                  mono
                />
              )}
              {sale.dueDate && (
                <Detail
                  label="Due"
                  value={formatDate(sale.dueDate, { style: "short" })}
                />
              )}
              {Number(sale.costOfGoodsSold) > 0 && (
                <Detail
                  label="Cost of goods sold"
                  value={formatCurrency(sale.costOfGoodsSold)}
                />
              )}
              {taxNotice && (
                <p className="border-t pt-3 text-xs leading-relaxed text-muted-foreground">
                  {taxNotice}
                </p>
              )}
            </CardContent>
          </Card>

          {sale.notes && (
            <Card>
              <CardContent className="py-5 text-sm leading-relaxed">
                {sale.notes}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  muted,
}: {
  label: string;
  value: unknown;
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between">
      <span className={muted ? "text-muted-foreground" : undefined}>
        {label}
      </span>
      <span className="tabular-figures">
        {formatCurrency(String(value as string))}
      </span>
    </div>
  );
}

function Detail({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? "font-mono text-xs" : "capitalize"}>{value}</span>
    </div>
  );
}
