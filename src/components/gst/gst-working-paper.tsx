"use client";

import * as React from "react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, FileText, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatDate } from "@/lib/format";
import { HEAD_LABELS } from "@/lib/tax/set-off";
import type {
  GstWorkingPaper,
  RateSummary,
} from "@/server/gst/gst-return-service";

/**
 * The GST working paper.
 *
 * Everything on this page is a preparation. The banner says so, the tab labels
 * say so, and there is no button anywhere that could be mistaken for filing —
 * because a retailer who believes their return has gone in when it has not is
 * worse off than one with no software at all.
 *
 * The figures are real: they come from the tax register the sales and purchase
 * modules write as they post, reconciled against the GST accounts in the ledger.
 * What the product does not do is submit them, and it does not pretend to.
 */
export function GstWorkingPaperView({
  paper,
  periods,
}: {
  paper: GstWorkingPaper;
  periods: Array<{ year: number; month: number; label: string }>;
}) {
  const router = useRouter();
  const value = `${paper.periodYear}-${paper.periodMonth}`;

  return (
    <div className="space-y-5">
      <PreparationBanner paper={paper} />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="flex flex-col gap-1.5 text-xs">
          <span className="text-muted-foreground">Period</span>
          <Select
            value={value}
            onValueChange={(next) => {
              const [year, month] = next.split("-");
              router.push(`/app/gst?year=${year}&month=${month}` as Route);
            }}
          >
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {periods.length === 0 && (
                <SelectItem value={value}>{paper.label}</SelectItem>
              )}
              {periods.map((period) => (
                <SelectItem
                  key={`${period.year}-${period.month}`}
                  value={`${period.year}-${period.month}`}
                >
                  {period.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <p className="text-xs text-muted-foreground">
          {formatDate(paper.from, { style: "short" })} to{" "}
          {formatDate(paper.to, { style: "short" })}
        </p>
      </div>

      {paper.empty ? (
        <div className="rounded-xl border border-dashed px-6 py-14 text-center">
          <h2 className="text-base font-semibold">
            Nothing to prepare for {paper.label}
          </h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
            No sale or purchase in this period carried GST. Record one and the
            working paper builds itself from the tax on the documents.
          </p>
        </div>
      ) : (
        <>
          <ReconciliationNote paper={paper} />

          <Tabs defaultValue="summary">
            <TabsList>
              <TabsTrigger value="summary">What you owe</TabsTrigger>
              <TabsTrigger value="outward">Sales (GSTR-1)</TabsTrigger>
              <TabsTrigger value="inward">Purchases</TabsTrigger>
            </TabsList>

            <TabsContent value="summary" className="pt-5">
              <SetOffPanel paper={paper} />
            </TabsContent>
            <TabsContent value="outward" className="pt-5">
              <OutwardPanel paper={paper} />
            </TabsContent>
            <TabsContent value="inward" className="pt-5">
              <InwardPanel paper={paper} />
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}

function PreparationBanner({ paper }: { paper: GstWorkingPaper }) {
  const composition = paper.registration === "COMPOSITION";
  const unregistered = paper.registration === "UNREGISTERED";

  return (
    <div className="rounded-xl border border-warning/40 bg-warning/5 px-5 py-4">
      <p className="flex items-center gap-2 text-sm font-medium">
        <FileText className="size-4" />
        Prepared for review — not filed
      </p>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
        This is a working paper built from the invoices and bills you have
        recorded. It has not been submitted to anyone, and nothing on this page
        can submit it. Have your accountant check it, then file on the GST
        portal.
        {composition &&
          " Your business is registered under the composition scheme, so the return you actually file is different from the one prepared here — treat these figures as a record of the tax on your documents, not as a draft return."}
        {unregistered &&
          " Your business is recorded as unregistered, so no GST return is due. These figures exist because tax appeared on documents you recorded."}
      </p>
    </div>
  );
}

function ReconciliationNote({ paper }: { paper: GstWorkingPaper }) {
  const { reconciliation } = paper;

  if (reconciliation.agrees) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border px-5 py-3">
        <span className="flex items-center gap-2 text-sm font-medium text-success-foreground">
          <CheckCircle2 className="size-4" />
          The tax register agrees with the books
        </span>
        <span className="text-xs text-muted-foreground">
          Output {formatCurrency(reconciliation.outputFromRegister)} · Input{" "}
          {formatCurrency(reconciliation.inputFromRegister)}
        </span>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-5 py-4">
      <p className="flex items-center gap-2 text-sm font-medium text-destructive">
        <AlertTriangle className="size-4" />
        The tax register and the books disagree
      </p>
      <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs text-destructive sm:grid-cols-2">
        <Line
          label="Output tax — register"
          value={reconciliation.outputFromRegister}
        />
        <Line
          label="Output tax — ledger"
          value={reconciliation.outputFromLedger}
        />
        <Line
          label="Input credit — register"
          value={reconciliation.inputFromRegister}
        />
        <Line
          label="Input credit — ledger"
          value={reconciliation.inputFromLedger}
        />
      </dl>
      <p className="mt-2.5 text-xs leading-relaxed text-destructive">
        GST is recorded twice — as rows in the tax register and as balances in
        the GST accounts — by different parts of the system. A difference means
        this working paper is being prepared from figures the books do not
        support. Do not file from it until the difference is explained.
      </p>
    </div>
  );
}

function SetOffPanel({ paper }: { paper: GstWorkingPaper }) {
  const { setOff } = paper;
  const owes = Number(setOff.totalPayable) > 0;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border">
        <div className="border-b px-5 py-4">
          <h2 className="text-base font-semibold">
            Tax payable for {paper.label}
          </h2>
          <p className="text-xs text-muted-foreground">
            Output tax on your sales, less the credit you may claim on
            purchases.
          </p>
        </div>

        <div className="overflow-x-auto">
          <Table className="border-0">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Head</TableHead>
                <TableHead className="text-right">Tax on sales</TableHead>
                <TableHead className="text-right">Credit available</TableHead>
                <TableHead className="text-right">Payable in cash</TableHead>
                <TableHead className="pr-5 text-right">
                  Carried forward
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(["igst", "cgst", "sgst", "cess"] as const).map((head) => (
                <TableRow key={head}>
                  <TableCell className="pl-5 text-sm font-medium">
                    {HEAD_LABELS[head]}
                  </TableCell>
                  <Amount value={setOff.liability[head] ?? "0"} />
                  <Amount value={setOff.credit[head] ?? "0"} />
                  <Amount value={setOff.payable[head] ?? "0"} />
                  <Amount
                    value={setOff.carriedForward[head] ?? "0"}
                    className="pr-5"
                  />
                </TableRow>
              ))}
              <TableRow className="bg-secondary/50">
                <TableCell className="pl-5 text-sm font-semibold">
                  Total
                </TableCell>
                <TableCell />
                <TableCell />
                <TableCell className="tabular-figures text-right text-base font-semibold">
                  {formatCurrency(setOff.totalPayable)}
                </TableCell>
                <TableCell className="tabular-figures pr-5 text-right text-sm font-medium">
                  {formatCurrency(setOff.totalCarriedForward)}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>

        <div className="border-t px-5 py-3">
          <p className="text-sm">
            {owes ? (
              <>
                On these figures{" "}
                <span className="font-semibold">
                  {formatCurrency(setOff.totalPayable)}
                </span>{" "}
                would be payable in cash for {paper.label}.
              </>
            ) : (
              <>
                On these figures nothing would be payable in cash for{" "}
                {paper.label}
                {Number(setOff.totalCarriedForward) > 0 && (
                  <>
                    , and{" "}
                    <span className="font-semibold">
                      {formatCurrency(setOff.totalCarriedForward)}
                    </span>{" "}
                    of credit would carry forward
                  </>
                )}
                .
              </>
            )}
          </p>
        </div>
      </div>

      {/* Shown whether or not any credit was applied. "Why am I paying the
          whole amount?" is asked most often when there was no credit, which is
          exactly when a rule explained only alongside its own arithmetic would
          have disappeared. */}
      <div className="rounded-xl border px-5 py-4">
        <h3 className="text-sm font-semibold">How the credit was applied</h3>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          The order is prescribed, not a choice: IGST credit is used first and
          must be exhausted before CGST or SGST credit is touched, and CGST
          credit can never be set against SGST or the other way round.
        </p>
        {setOff.steps.length === 0 ? (
          <p className="mt-3 text-sm">
            {Number(setOff.totalPayable) > 0
              ? "No credit was available to set off in this period, so the whole of the tax on your sales is payable."
              : "There was nothing to set off in this period."}
          </p>
        ) : (
          <ul className="mt-3 space-y-1.5">
            {setOff.steps.map((step, index) => (
              <li
                key={`${step.from}-${step.against}-${index}`}
                className="flex items-baseline justify-between gap-3 text-sm"
              >
                <span>
                  {HEAD_LABELS[step.from as keyof typeof HEAD_LABELS]} credit
                  against{" "}
                  {HEAD_LABELS[step.against as keyof typeof HEAD_LABELS]}
                </span>
                <span className="tabular-figures">
                  {formatCurrency(step.amount)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Note>
        Credit is only counted where it may actually be claimed. Tax on a
        purchase you marked as not claimable never became an asset — it went
        into the cost of the goods and belongs in the profit and loss account,
        not here.
      </Note>
    </div>
  );
}

function OutwardPanel({ paper }: { paper: GstWorkingPaper }) {
  const { outward } = paper;

  return (
    <div className="space-y-4">
      <Section
        title="To registered customers (B2B)"
        subtitle={`${outward.b2b.length} ${outward.b2b.length === 1 ? "customer" : "customers"} · ${outward.b2bTotal.documents} invoices`}
      >
        {outward.b2b.length === 0 ? (
          <Empty>No sales to a customer with a GSTIN in this period.</Empty>
        ) : (
          <Table className="border-0">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Customer</TableHead>
                <TableHead>GSTIN</TableHead>
                <TableHead className="text-right">Invoices</TableHead>
                <TableHead className="text-right">Taxable</TableHead>
                <TableHead className="pr-5 text-right">Tax</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {outward.b2b.map((party) => (
                <TableRow key={`${party.partyGstin}-${party.partyName}`}>
                  <TableCell className="pl-5 text-sm">
                    {party.partyName}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {party.partyGstin}
                  </TableCell>
                  <TableCell className="tabular-figures text-right text-sm">
                    {party.documents}
                  </TableCell>
                  <Amount value={party.taxableValue} />
                  <Amount value={party.totalTax} className="pr-5" />
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section
        title="To everyone else (B2C)"
        subtitle={`${outward.b2cTotal.documents} invoices, summarised by rate`}
      >
        <RateTable rows={outward.b2cByRate} />
      </Section>

      <Section title="All sales by rate" subtitle="The rate-wise summary">
        <RateTable rows={outward.byRate} total={outward.total} />
      </Section>

      <Section title="By HSN code" subtitle="Required on the return">
        {outward.byHsn.length === 0 ? (
          <Empty>Nothing to show.</Empty>
        ) : (
          <Table className="border-0">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">HSN</TableHead>
                <TableHead className="text-right">Invoices</TableHead>
                <TableHead className="text-right">Taxable</TableHead>
                <TableHead className="pr-5 text-right">Tax</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {outward.byHsn.map((row) => (
                <TableRow key={row.hsnCode}>
                  <TableCell className="pl-5 font-mono text-sm">
                    {row.hsnCode}
                  </TableCell>
                  <TableCell className="tabular-figures text-right text-sm">
                    {row.documents}
                  </TableCell>
                  <Amount value={row.taxableValue} />
                  <Amount value={row.totalTax} className="pr-5" />
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
    </div>
  );
}

function InwardPanel({ paper }: { paper: GstWorkingPaper }) {
  const { inward } = paper;
  const hasIneligible = Number(inward.ineligible.totalTax) > 0;

  return (
    <div className="space-y-4">
      <Section
        title="Credit you can claim"
        subtitle={`${inward.eligible.documents} bills`}
      >
        <div className="px-5 py-4">
          <p className="tabular-figures text-2xl font-semibold">
            {formatCurrency(inward.eligible.totalTax)}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            On {formatCurrency(inward.eligible.taxableValue)} of purchases.
          </p>
        </div>
      </Section>

      {hasIneligible && (
        <Section
          title="Tax you cannot claim"
          subtitle={`${inward.ineligible.documents} bills`}
        >
          <div className="px-5 py-4">
            <p className="tabular-figures text-xl font-semibold">
              {formatCurrency(inward.ineligible.totalTax)}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              This tax was not treated as recoverable when the bill was
              recorded, so it went into the cost of the goods rather than into a
              credit. It is shown here so the two figures add up to the tax you
              actually paid — it is not part of the claim.
            </p>
          </div>
        </Section>
      )}

      <Section title="Purchases by rate" subtitle="Everything bought in">
        <RateTable rows={inward.byRate} />
      </Section>

      <Section
        title="By supplier"
        subtitle="Worth comparing against what they have filed"
      >
        {inward.bySupplier.length === 0 ? (
          <Empty>No purchases carried GST in this period.</Empty>
        ) : (
          <Table className="border-0">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Supplier</TableHead>
                <TableHead>GSTIN</TableHead>
                <TableHead className="text-right">Bills</TableHead>
                <TableHead className="text-right">Taxable</TableHead>
                <TableHead className="pr-5 text-right">Tax</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {inward.bySupplier.map((party) => (
                <TableRow key={`${party.partyGstin}-${party.partyName}`}>
                  <TableCell className="pl-5 text-sm">
                    {party.partyName}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {party.partyGstin ?? (
                      <span className="text-muted-foreground">none</span>
                    )}
                  </TableCell>
                  <TableCell className="tabular-figures text-right text-sm">
                    {party.documents}
                  </TableCell>
                  <Amount value={party.taxableValue} />
                  <Amount value={party.totalTax} className="pr-5" />
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Note>
        Credit here is what your own records support. The portal will only allow
        what your suppliers have actually filed, so a difference between this
        and GSTR-2B is a conversation to have with a supplier, not an error in
        your books.
      </Note>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function RateTable({
  rows,
  total,
}: {
  rows: RateSummary[];
  total?: RateSummary;
}) {
  if (rows.length === 0) return <Empty>Nothing in this period.</Empty>;

  return (
    <div className="overflow-x-auto">
      <Table className="border-0">
        <TableHeader>
          <TableRow>
            <TableHead className="pl-5">Rate</TableHead>
            <TableHead className="text-right">Taxable</TableHead>
            <TableHead className="text-right">CGST</TableHead>
            <TableHead className="text-right">SGST</TableHead>
            <TableHead className="text-right">IGST</TableHead>
            <TableHead className="pr-5 text-right">Total tax</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.ratePercent}>
              <TableCell className="pl-5 text-sm">
                <Badge variant="muted">{Number(row.ratePercent)}%</Badge>
              </TableCell>
              <Amount value={row.taxableValue} />
              <Amount value={row.cgst} />
              <Amount value={row.sgst} />
              <Amount value={row.igst} />
              <Amount value={row.totalTax} className="pr-5" />
            </TableRow>
          ))}
          {total && (
            <TableRow className="bg-secondary/50">
              <TableCell className="pl-5 text-sm font-semibold">
                Total
              </TableCell>
              <Amount value={total.taxableValue} bold />
              <Amount value={total.cgst} bold />
              <Amount value={total.sgst} bold />
              <Amount value={total.igst} bold />
              <Amount value={total.totalTax} className="pr-5" bold />
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function Amount({
  value,
  className,
  bold,
}: {
  value: string;
  className?: string;
  bold?: boolean;
}) {
  return (
    <TableCell
      className={`tabular-figures text-right text-sm ${bold ? "font-semibold" : ""} ${className ?? ""}`}
    >
      {Number(value) === 0 ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        formatCurrency(value)
      )}
    </TableCell>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border">
      <div className="border-b px-5 py-3.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-5 py-6 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt>{label}</dt>
      <dd className="tabular-figures font-medium">{formatCurrency(value)}</dd>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
      <Info className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
