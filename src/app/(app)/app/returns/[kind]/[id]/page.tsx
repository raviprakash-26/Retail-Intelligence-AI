import type { Metadata } from "next";
import Link from "next/link";
import type { Route } from "next";
import { notFound } from "next/navigation";
import { ArrowLeft, Undo2 } from "lucide-react";
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
import { formatCurrency, formatDate, formatNumber } from "@/lib/format";
import { requirePermission } from "@/server/auth/context";
import { MasterDataError } from "@/server/master-data/errors";
import {
  getPurchaseReturn,
  getSalesReturn,
  type ReturnDetail,
} from "@/server/returns/return-queries";

export const metadata: Metadata = {
  title: "Return",
  robots: { index: false, follow: false },
};

/**
 * One credit or debit note, and the entry it produced.
 *
 * The journal entry is on the page for the same reason it is on the invoice: a
 * shopkeeper who can see that a ₹472 credit note debited Sales Returns rather
 * than reducing Sales — and put ₹240 of stock back at what it cost — can check
 * the books rather than trust them.
 */

const COPY = {
  sales: {
    title: "Credit note",
    against: "Invoice",
    party: "Customer",
    sourceHref: (id: string) => `/app/sales/${id}` as Route,
    entryNote:
      "The return sits in Sales Returns beside Sales rather than inside it, so the gross figure and the return rate both stay visible. The stock came back at what it originally cost, not at today's average — otherwise goods that only travelled to the customer and back would have earned a profit.",
  },
  purchase: {
    title: "Debit note",
    against: "Bill",
    party: "Supplier",
    sourceHref: (id: string) => `/app/purchases/${id}` as Route,
    entryNote:
      "A purchase was never an expense here — it debited stock — so the return credits stock. Where what the supplier refunds and what the shelf gave up differ, the gap is a real cost and is shown as one rather than being left inside the value of goods that have gone.",
  },
} as const;

export default async function ReturnDetailPage({
  params,
}: {
  params: Promise<{ kind: string; id: string }>;
}) {
  const { kind, id } = await params;
  if (kind !== "sales" && kind !== "purchase") notFound();

  const context = await requirePermission(
    kind === "sales" ? "sales.view" : "purchases.view",
  );

  const detail: ReturnDetail = await (
    kind === "sales"
      ? getSalesReturn({ companyId: context.company.id, id })
      : getPurchaseReturn({ companyId: context.company.id, id })
  ).catch((error: unknown) => {
    if (error instanceof MasterDataError) notFound();
    throw error;
  });

  const copy = COPY[kind];
  const taxTotal =
    Number(detail.cgstAmount) +
    Number(detail.sgstAmount) +
    Number(detail.igstAmount) +
    Number(detail.cessAmount);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <Link
        href={`/app/returns?type=${kind}` as Route}
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        <ArrowLeft className="size-3.5" />
        All returns
      </Link>

      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex flex-wrap items-center gap-2.5 text-2xl font-semibold tracking-tight">
            {detail.returnNumber}
            <Badge variant="muted">
              <Undo2 className="size-3" />
              {copy.title}
            </Badge>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatDate(detail.returnDate, { style: "long" })} ·{" "}
            {detail.partyName}
            {detail.against && (
              <>
                {" · against "}
                <Link
                  href={copy.sourceHref(detail.against.id)}
                  className="underline underline-offset-4 hover:text-foreground"
                >
                  {detail.against.number}
                </Link>
              </>
            )}
          </p>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>What came back</CardTitle>
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
                  {detail.items.map((item) => (
                    <TableRow key={item.lineNumber}>
                      <TableCell className="pl-6">
                        <p className="font-medium">{item.productName}</p>
                        <p className="font-mono text-xs text-muted-foreground">
                          {item.sku}
                        </p>
                      </TableCell>
                      <TableCell className="tabular-figures text-right">
                        {formatNumber(item.quantity)}
                      </TableCell>
                      <TableCell className="tabular-figures text-right">
                        {formatCurrency(item.rate, {
                          compactZeroDecimals: true,
                        })}
                      </TableCell>
                      <TableCell className="tabular-figures text-right">
                        {formatCurrency(item.taxableAmount)}
                      </TableCell>
                      <TableCell className="tabular-figures text-right">
                        {Number(item.taxPercent) === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <>
                            {formatCurrency(item.taxAmount)}
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

          {detail.entry && (
            <Card>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2">
                  Journal entry {detail.entry.entryNumber}
                  {detail.entry.status === "REVERSED" && (
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
                    {detail.entry.lines.map((line) => (
                      <TableRow key={line.lineNumber}>
                        <TableCell className="pl-6">
                          <p className="text-sm">{line.accountName}</p>
                          <p className="font-mono text-xs text-muted-foreground">
                            {line.accountCode}
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
                  Debits equal credits at{" "}
                  {formatCurrency(detail.entry.totalDebit)}. {copy.entryNote}
                </p>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <CardContent className="space-y-2 py-5 text-sm">
              <Row label="Taxable value" value={detail.taxableAmount} />
              {Number(detail.cgstAmount) > 0 && (
                <Row label="CGST" value={detail.cgstAmount} muted />
              )}
              {Number(detail.sgstAmount) > 0 && (
                <Row label="SGST" value={detail.sgstAmount} muted />
              )}
              {Number(detail.igstAmount) > 0 && (
                <Row label="IGST" value={detail.igstAmount} muted />
              )}
              {Number(detail.cessAmount) > 0 && (
                <Row label="Cess" value={detail.cessAmount} muted />
              )}
              {Number(detail.roundOff) !== 0 && (
                <Row label="Round off" value={detail.roundOff} muted />
              )}
              <div className="flex items-baseline justify-between border-t pt-3">
                <span className="font-medium">Total</span>
                <span className="tabular-figures text-lg font-semibold">
                  {formatCurrency(detail.totalAmount)}
                </span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-3 py-5 text-sm">
              <Detail label={copy.party} value={detail.partyName} />
              {detail.partyGstin && (
                <Detail label="GSTIN" value={detail.partyGstin} mono />
              )}
              <Detail
                label={copy.against}
                value={detail.against?.number ?? "—"}
              />
              {detail.against && (
                <Detail
                  label={`${copy.against} date`}
                  value={formatDate(detail.against.date, { style: "short" })}
                />
              )}
              {detail.costReturned !== null &&
                Number(detail.costReturned) > 0 && (
                  <Detail
                    label="Stock put back at cost"
                    value={formatCurrency(detail.costReturned)}
                  />
                )}
              {taxTotal > 0 && (
                <p className="border-t pt-3 text-xs leading-relaxed text-muted-foreground">
                  {formatCurrency(taxTotal)} of GST was reversed. The register
                  carries this as a negative supply rather than by editing the
                  original document&rsquo;s rows, so a period already reviewed
                  still reads the way it did when it was reviewed.
                </p>
              )}
            </CardContent>
          </Card>

          {detail.reason && (
            <Card>
              <CardContent className="py-5 text-sm leading-relaxed">
                <p className="mb-1 text-xs text-muted-foreground">Reason</p>
                {detail.reason}
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
  value: string;
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between">
      <span className={muted ? "text-muted-foreground" : undefined}>
        {label}
      </span>
      <span className="tabular-figures">{formatCurrency(value)}</span>
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
      <span className={mono ? "font-mono text-xs" : undefined}>{value}</span>
    </div>
  );
}
