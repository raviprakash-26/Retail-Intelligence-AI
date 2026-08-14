import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Ban } from "lucide-react";
import { VoidDocumentDialog } from "@/components/documents/void-document-dialog";
import { PurchaseReturnButton } from "@/components/returns/return-buttons";
import { ReturnsAgainstCard } from "@/components/returns/returns-against-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { requirePermission } from "@/server/auth/context";
import { getPurchase } from "@/server/purchases/purchase-service";
import { voidPurchaseAction } from "@/server/purchases/actions";
import { returnableBillLines } from "@/server/returns/purchase-return-service";
import { purchaseReturnsAgainst } from "@/server/returns/return-queries";
import { MasterDataError } from "@/server/master-data/errors";

export const metadata: Metadata = {
  title: "Bill",
  robots: { index: false, follow: false },
};

/**
 * One bill, and the entry it produced.
 *
 * The entry is on the same page as the document because that is where a
 * retailer learns what a purchase actually did to their books — that ₹1,180
 * became ₹1,000 of stock and ₹180 of tax they can reclaim, or ₹1,180 of stock
 * if they cannot.
 */
export default async function PurchaseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const context = await requirePermission("purchases.view");
  const { id } = await params;

  const detail = await getPurchase({
    companyId: context.company.id,
    purchaseId: id,
  }).catch((error: unknown) => {
    if (error instanceof MasterDataError) notFound();
    throw error;
  });

  const { purchase, entry } = detail;
  const voided = purchase.status === "VOIDED";
  const totalTax =
    Number(purchase.cgstAmount) +
    Number(purchase.sgstAmount) +
    Number(purchase.igstAmount) +
    Number(purchase.cessAmount);

  const mayReturn = !voided && context.permissions.has("purchases.return");
  const [returnable, returns] = await Promise.all([
    mayReturn
      ? returnableBillLines({
          companyId: context.company.id,
          purchaseId: purchase.id,
        })
      : Promise.resolve([]),
    purchaseReturnsAgainst({
      companyId: context.company.id,
      purchaseId: purchase.id,
    }),
  ]);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <Link
        href="/app/purchases"
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        <ArrowLeft className="size-3.5" />
        All bills
      </Link>

      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex flex-wrap items-center gap-2.5 text-2xl font-semibold tracking-tight">
            <span className={voided ? "line-through" : undefined}>
              {purchase.billNumber}
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
            {formatDate(purchase.billDate, { style: "long" })} ·{" "}
            {purchase.supplier?.name ?? "Supplier"}
            {purchase.supplierBillNo
              ? ` · their ref ${purchase.supplierBillNo}`
              : ""}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {mayReturn && returnable.length > 0 && (
            <PurchaseReturnButton
              documentId={purchase.id}
              documentNumber={purchase.billNumber}
              documentDate={purchase.billDate.toISOString().slice(0, 10)}
              lines={returnable}
            />
          )}
          {!voided && context.permissions.has("purchases.void") && (
            <VoidDocumentDialog
              documentId={purchase.id}
              documentNumber={purchase.billNumber}
              noun="bill"
              onVoid={voidPurchaseAction}
              placeholder="Bill entered twice"
            />
          )}
        </div>
      </header>

      {voided && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>This bill was voided</AlertTitle>
          <AlertDescription>
            {purchase.voidReason}
            {purchase.voidedAt
              ? ` — ${formatDate(purchase.voidedAt, { style: "long" })}`
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
                    <TableHead className="pr-6 text-right">
                      Landed cost
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {purchase.items.map((item) => (
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
                        {formatCurrency(item.unitCost)}
                        <span className="block text-xs text-muted-foreground">
                          per {item.product.unit.code}
                        </span>
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
                  {totalTax > 0 && (
                    <>
                      {" "}
                      {purchase.itcEligible
                        ? `The ${formatCurrency(totalTax)} of GST sits in the input accounts as an asset — it is set against the GST you collect, not added to what the goods cost.`
                        : `The ${formatCurrency(totalTax)} of GST is not recoverable here, so it is part of the cost rather than an asset.`}
                    </>
                  )}
                </p>
              </CardContent>
            </Card>
          )}

          <ReturnsAgainstCard
            kind="purchase"
            rows={returns.rows}
            total={returns.total}
            documentNoun="bill"
          />
        </div>

        <div className="space-y-6">
          <Card>
            <CardContent className="space-y-2 py-5 text-sm">
              <Row label="Taxable value" value={purchase.taxableAmount} />
              {Number(purchase.discountAmount) > 0 && (
                <Row label="Discount" value={purchase.discountAmount} muted />
              )}
              {Number(purchase.cgstAmount) > 0 && (
                <Row label="CGST" value={purchase.cgstAmount} muted />
              )}
              {Number(purchase.sgstAmount) > 0 && (
                <Row label="SGST" value={purchase.sgstAmount} muted />
              )}
              {Number(purchase.igstAmount) > 0 && (
                <Row label="IGST" value={purchase.igstAmount} muted />
              )}
              {Number(purchase.roundOff) !== 0 && (
                <Row label="Round off" value={purchase.roundOff} muted />
              )}
              <div className="flex items-baseline justify-between border-t pt-3">
                <span className="font-medium">Total</span>
                <span className="tabular-figures text-lg font-semibold">
                  {formatCurrency(purchase.totalAmount)}
                </span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-3 py-5 text-sm">
              <Detail
                label="Payment"
                value={purchase.paymentMode.toLowerCase()}
              />
              <Detail
                label="Tax treatment"
                value={
                  purchase.supplyType === "INTRA_STATE"
                    ? "CGST + SGST"
                    : purchase.supplyType === "INTER_STATE"
                      ? "IGST"
                      : "No GST"
                }
              />
              {totalTax > 0 && (
                <Detail
                  label="Input credit"
                  value={purchase.itcEligible ? "claimable" : "part of cost"}
                />
              )}
              {purchase.supplier?.gstin && (
                <Detail
                  label="Supplier GSTIN"
                  value={purchase.supplier.gstin}
                  mono
                />
              )}
              {purchase.supplier?.stateCode && (
                <Detail
                  label="Billed from"
                  value={
                    findStateByCode(purchase.supplier.stateCode)?.name ??
                    purchase.supplier.stateCode
                  }
                />
              )}
              {purchase.dueDate && (
                <Detail
                  label="Due"
                  value={formatDate(purchase.dueDate, { style: "short" })}
                />
              )}
            </CardContent>
          </Card>

          {purchase.notes && (
            <Card>
              <CardContent className="py-5 text-sm leading-relaxed">
                {purchase.notes}
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
