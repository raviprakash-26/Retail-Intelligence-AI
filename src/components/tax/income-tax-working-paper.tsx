"use client";

import * as React from "react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { AlertTriangle, Calculator, CheckCircle2, Info } from "lucide-react";
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
import { formatCurrency, formatDate, formatPercent } from "@/lib/format";
import { ASSESSEE_LABELS } from "@/lib/tax/income-tax";
import {
  CASH_PAYMENT_LIMIT,
  RATE_ON_CASH,
  RATE_ON_DIGITAL,
} from "@/lib/tax/presumptive";
import type {
  RegimeOutcome,
  TaxWorkingPaper,
} from "@/server/tax/income-tax-service";

/**
 * The income tax working paper.
 *
 * Everything on this page is an estimate offered for review. It says so at the
 * top, it says so on the figure that matters most, and there is no control
 * anywhere that files, submits or pays anything — because the platform cannot
 * do any of those, and an owner who thinks otherwise is worse off than one with
 * no software at all.
 *
 * The figures are real: they come out of the same books as the profit and loss
 * account, and every adjustment between the two is on the page with the reason
 * for it. What the page will not do is collapse the judgement calls into one
 * confident number — the items that turn on facts the platform cannot see are
 * shown as a second figure, so the answer reads as the range it actually is.
 */
export function IncomeTaxWorkingPaper({
  paper,
  years,
}: {
  paper: TaxWorkingPaper;
  years: Array<{ id: string; label: string }>;
}) {
  const router = useRouter();

  return (
    <div className="space-y-5">
      <EstimateBanner paper={paper} />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="flex flex-col gap-1.5 text-xs">
          <span className="text-muted-foreground">Financial year</span>
          <Select
            value={paper.fiscalYear.id}
            onValueChange={(next) => {
              router.push(`/app/tax?year=${next}` as Route);
            }}
          >
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {years.length === 0 && (
                <SelectItem value={paper.fiscalYear.id}>
                  {paper.fiscalYear.label}
                </SelectItem>
              )}
              {years.map((year) => (
                <SelectItem key={year.id} value={year.id}>
                  {year.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <div className="text-right text-xs text-muted-foreground">
          <p>
            {formatDate(paper.fiscalYear.from, { style: "short" })} to{" "}
            {formatDate(paper.fiscalYear.to, { style: "short" })}
          </p>
          <p>
            Assessment year {paper.assessmentYear} ·{" "}
            {ASSESSEE_LABELS[paper.assessee]}
          </p>
        </div>
      </div>

      {!paper.ratesKnown && (
        <div className="rounded-xl border border-warning/40 bg-warning/5 px-5 py-4">
          <p className="flex items-center gap-2 text-sm font-medium">
            <AlertTriangle className="size-4" />
            No rates are held for assessment year {paper.assessmentYear}
          </p>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
            Rather than apply another year&rsquo;s rates and produce a
            computation that looks correct and is not, nothing has been
            computed. The figures from your books are below, and your accountant
            can take them from there.
          </p>
        </div>
      )}

      {paper.ratesProvisional && (
        <div className="rounded-xl border border-warning/40 bg-warning/5 px-5 py-4">
          <p className="flex items-center gap-2 text-sm font-medium">
            <AlertTriangle className="size-4" />
            The rates for assessment year {paper.assessmentYear} are carried
            forward
          </p>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
            The Finance Act for this year has not been entered, so last
            year&rsquo;s rates have been used. Most years most rates do not
            move, so this is usually right — and &ldquo;usually right&rdquo; is
            exactly the sort of thing that has to be said out loud. Treat every
            tax figure below as provisional until the rates are confirmed.
          </p>
        </div>
      )}

      {paper.empty ? (
        <div className="rounded-xl border border-dashed px-6 py-14 text-center">
          <h2 className="text-base font-semibold">
            Nothing to compute for {paper.fiscalYear.label}
          </h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
            No trading has been recorded in this year. Post a sale or a purchase
            and the computation builds itself from the books.
          </p>
        </div>
      ) : (
        <Tabs defaultValue="computation">
          {/* Five tabs do not fit a phone, and a list wider than the viewport
              widens the whole document rather than scrolling inside itself. */}
          <div className="overflow-x-auto">
            <TabsList className="w-max">
              <TabsTrigger value="computation">Computation</TabsTrigger>
              <TabsTrigger value="review">To review</TabsTrigger>
              <TabsTrigger value="depreciation">Depreciation</TabsTrigger>
              <TabsTrigger value="presumptive">Section 44AD</TabsTrigger>
              <TabsTrigger value="advance">Advance tax</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="computation" className="pt-5">
            <ComputationPanel paper={paper} />
          </TabsContent>
          <TabsContent value="review" className="pt-5">
            <ReviewPanel paper={paper} />
          </TabsContent>
          <TabsContent value="depreciation" className="pt-5">
            <DepreciationPanel paper={paper} />
          </TabsContent>
          <TabsContent value="presumptive" className="pt-5">
            <PresumptivePanel paper={paper} />
          </TabsContent>
          <TabsContent value="advance" className="pt-5">
            <AdvanceTaxPanel paper={paper} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function EstimateBanner({ paper }: { paper: TaxWorkingPaper }) {
  const proprietor = paper.assessee === "INDIVIDUAL";

  return (
    <div className="rounded-xl border border-warning/40 bg-warning/5 px-5 py-4">
      <p className="flex items-center gap-2 text-sm font-medium">
        <Calculator className="size-4" />
        Estimated — prepared for review, not filed
      </p>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
        This is an estimate worked out from your books, not a return and not
        professional tax advice. Nothing on this page has been filed, and
        nothing on this page can file it. Have your accountant check it, then
        file on the income tax portal.
        {proprietor
          ? " Your business is a proprietorship, so this income is taxed as part of your own — salary, interest, rent, capital gains, deductions under Chapter VI-A and losses brought forward all change the answer, and none of them is visible here."
          : " Deductions under Chapter VI-A, losses brought forward from earlier years and income under other heads all change the answer, and none of them is visible here."}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Computation
// ---------------------------------------------------------------------------

function ComputationPanel({ paper }: { paper: TaxWorkingPaper }) {
  const hasFlags = Number(paper.flagged.total) > 0;

  return (
    <div className="space-y-4">
      <Section
        title={`Income from business — ${paper.fiscalYear.label}`}
        subtitle="Starting from the profit and loss account, with every adjustment shown"
      >
        <dl className="divide-y">
          {paper.computation.map((line) => (
            <div
              key={line.label}
              className={`flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-5 py-3 ${
                line.emphasis === "total" ? "bg-secondary/50" : ""
              }`}
            >
              <dt className="min-w-0 flex-1">
                <span
                  className={`text-sm ${line.emphasis === "total" ? "font-semibold" : ""}`}
                >
                  {line.label}
                </span>
                {line.note && (
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {line.note}
                  </p>
                )}
              </dt>
              <dd
                className={`tabular-figures shrink-0 text-right ${
                  line.emphasis === "total"
                    ? "text-base font-semibold"
                    : "text-sm"
                }`}
              >
                {formatCurrency(line.amount)}
              </dd>
            </div>
          ))}
        </dl>
      </Section>

      {paper.loss && (
        <div className="rounded-xl border px-5 py-4">
          <p className="text-sm font-medium">This year is in loss</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            There is no tax on a loss, and there is no refund either. A business
            loss is carried forward and set against business income in later
            years, subject to the return being filed in time. This working paper
            does not track losses between years — that belongs with your
            accountant, along with anything brought forward into this one.
          </p>
        </div>
      )}

      {hasFlags && (
        <div className="rounded-xl border px-5 py-4">
          <p className="text-sm font-medium">
            The answer is a range, not a single figure
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {formatCurrency(paper.flagged.total)} of expenditure may not be
            allowed, on facts this platform cannot see for itself. If none of it
            is disallowed the income is {formatCurrency(paper.taxableIncome)};
            if all of it is, the income is{" "}
            {formatCurrency(paper.taxableIncomeWithDisallowances)}. What those
            items are, and what has to be checked about each, is on the next
            tab.
          </p>
        </div>
      )}

      {paper.regimes.length > 0 && <RegimeTable paper={paper} />}

      {paper.regimes.map((regime) => (
        <TaxDetail
          key={regime.regime}
          outcome={regime}
          only={paper.regimes.length === 1}
        />
      ))}

      {paper.basis && (
        <Note>
          Computed on the {paper.basis}. Rates change every February; if this
          year&rsquo;s law has moved since, the figures move with it.
        </Note>
      )}
    </div>
  );
}

function RegimeTable({ paper }: { paper: TaxWorkingPaper }) {
  const cheapest = paper.regimes[0];
  const dearest = paper.regimes[paper.regimes.length - 1];
  const difference =
    cheapest && dearest
      ? Number(dearest.normal.totalTax) - Number(cheapest.normal.totalTax)
      : 0;

  return (
    <Section
      title="What the tax comes to"
      subtitle={
        paper.regimeChoice
          ? "Both regimes, on the same income"
          : `${ASSESSEE_LABELS[paper.assessee]} — the regime choice does not apply`
      }
    >
      <div className="overflow-x-auto">
        <Table className="border-0">
          <TableHeader>
            <TableRow>
              <TableHead className="pl-5">Basis</TableHead>
              {paper.regimes.map((regime) => (
                <TableHead key={regime.regime} className="text-right last:pr-5">
                  {regime.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell className="pl-5 text-sm">
                {paper.loss
                  ? "On a business loss"
                  : `On ${formatCurrency(paper.taxableIncome)} of business income`}
              </TableCell>
              {paper.regimes.map((regime) => (
                <TableCell
                  key={regime.regime}
                  className="tabular-figures text-right text-sm font-semibold last:pr-5"
                >
                  {formatCurrency(regime.normal.roundedTax)}
                </TableCell>
              ))}
            </TableRow>

            {paper.regimes.some((regime) => regime.withDisallowances) && (
              <TableRow>
                <TableCell className="pl-5 text-sm">
                  If every item to review is disallowed
                </TableCell>
                {paper.regimes.map((regime) => (
                  <TableCell
                    key={regime.regime}
                    className="tabular-figures text-right text-sm last:pr-5"
                  >
                    {regime.withDisallowances
                      ? formatCurrency(regime.withDisallowances.roundedTax)
                      : "—"}
                  </TableCell>
                ))}
              </TableRow>
            )}

            {paper.regimes.some((regime) => regime.presumptive) && (
              <TableRow>
                <TableCell className="pl-5 text-sm">
                  Under section 44AD, on{" "}
                  {formatCurrency(paper.presumptive.incomeAtSplitRate)}
                </TableCell>
                {paper.regimes.map((regime) => (
                  <TableCell
                    key={regime.regime}
                    className="tabular-figures text-right text-sm last:pr-5"
                  >
                    {regime.presumptive
                      ? formatCurrency(regime.presumptive.roundedTax)
                      : "—"}
                  </TableCell>
                ))}
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {paper.regimeChoice && cheapest && (
        <div className="border-t px-5 py-3">
          <p className="text-sm leading-relaxed">
            {difference > 0 ? (
              <>
                On these figures the {cheapest.label.toLowerCase()} produces{" "}
                <span className="font-semibold">
                  {formatCurrency(difference)}
                </span>{" "}
                less tax. That is arithmetic on this year&rsquo;s business
                income alone — the deductions you can claim under the old
                regime, and income from anywhere else, may reverse it.
              </>
            ) : (
              <>
                On these figures both regimes come to the same tax. The
                deductions you can claim under the old regime, and income from
                anywhere else, would decide between them.
              </>
            )}
          </p>
        </div>
      )}
    </Section>
  );
}

function TaxDetail({
  outcome,
  only,
}: {
  outcome: RegimeOutcome;
  only: boolean;
}) {
  const tax = outcome.normal;

  return (
    <Section
      title={
        only
          ? "How the tax was worked out"
          : `How it works out — ${outcome.label.toLowerCase()}`
      }
      subtitle={
        tax.flatRatePercent !== null
          ? `A flat ${tax.flatRatePercent}% on the whole of the income`
          : "Band by band, then rebate, surcharge and cess"
      }
    >
      {tax.bands.length > 0 && (
        <div className="overflow-x-auto">
          <Table className="border-0">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Band</TableHead>
                <TableHead className="text-right">Rate</TableHead>
                <TableHead className="text-right">Income in band</TableHead>
                <TableHead className="pr-5 text-right">Tax</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tax.bands.map((band) => (
                <TableRow key={`${band.from}-${band.ratePercent}`}>
                  <TableCell className="pl-5 text-sm">
                    {formatCurrency(band.from)}
                    {band.to === null
                      ? " and above"
                      : ` to ${formatCurrency(band.to)}`}
                  </TableCell>
                  <TableCell className="text-right text-sm">
                    <Badge variant="muted">{band.ratePercent}%</Badge>
                  </TableCell>
                  <Amount value={band.income} />
                  <Amount value={band.tax} className="pr-5" />
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <dl className="divide-y border-t">
        <SummaryLine label="Tax on income" value={tax.taxOnIncome} />
        {Number(tax.rebate) > 0 && (
          <SummaryLine
            label="Less: rebate under section 87A"
            value={`-${tax.rebate}`}
            note={tax.rebateNote}
          />
        )}
        {Number(tax.surcharge) > 0 && (
          <SummaryLine
            label={`Add: surcharge at ${tax.surchargeRatePercent}%`}
            value={tax.surcharge}
          />
        )}
        {Number(tax.marginalRelief) > 0 && (
          <SummaryLine
            label="Less: marginal relief"
            value={`-${tax.marginalRelief}`}
            note="Crossing the surcharge threshold must not cost more than the income that crossed it."
          />
        )}
        <SummaryLine
          label={`Add: health and education cess at ${tax.cessPercent}%`}
          value={tax.cess}
        />
        <SummaryLine
          label="Estimated tax"
          value={tax.roundedTax}
          note="Rounded to the nearest ten rupees, as section 288B requires."
          emphasis
        />
      </dl>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Items to review
// ---------------------------------------------------------------------------

function ReviewPanel({ paper }: { paper: TaxWorkingPaper }) {
  const { flagged } = paper;
  const nothing =
    flagged.cashPayments.length === 0 &&
    flagged.unpaidBills.length === 0 &&
    Number(flagged.cashCapitalPaymentsTotal) === 0 &&
    Number(paper.otherIncomeInBooks) === 0;

  if (nothing) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 rounded-xl border px-5 py-4">
          <CheckCircle2 className="size-4 text-success-foreground" />
          <p className="text-sm">
            Nothing in this year&rsquo;s records trips any of the checks below.
          </p>
        </div>
        <Note>
          The checks are: cash paid to one person in one day above{" "}
          {formatCurrency(CASH_PAYMENT_LIMIT)}, supplier bills left unpaid past
          the time limit for a micro or small enterprise, and income in the
          profit and loss account that may belong under another head. Passing
          them is not the same as there being nothing to adjust — they are the
          ones a set of books can answer on its own.
        </Note>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {flagged.cashPayments.length > 0 && (
        <Section
          title="Cash paid above the section 40A(3) limit"
          subtitle={`${flagged.cashPayments.length} ${flagged.cashPayments.length === 1 ? "day" : "days"} · ${formatCurrency(flagged.cashPaymentsTotal)}`}
        >
          <div className="overflow-x-auto">
            <Table className="border-0">
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Paid to</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Vouchers</TableHead>
                  <TableHead className="pr-5 text-right">
                    Paid that day
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {flagged.cashPayments.map((day) => (
                  <TableRow key={`${day.partyName}-${day.date}`}>
                    <TableCell className="pl-5 text-sm">
                      {day.partyName}
                    </TableCell>
                    <TableCell className="text-sm">
                      {formatDate(day.date, { style: "short" })}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {day.vouchers.join(", ")}
                    </TableCell>
                    <Amount value={day.amount} className="pr-5" />
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="border-t px-5 py-3 text-xs leading-relaxed text-muted-foreground">
            The limit is on the total paid to one person in one day, not on any
            single voucher — three payments of ₹4,000 to the same supplier on
            the same date are caught. Where a day is over the limit the whole of
            it is disallowed, not the excess. Payments by cheque, bank transfer
            or UPI are outside the section entirely, and so are payments to a
            transporter up to ₹35,000.
          </p>
        </Section>
      )}

      {Number(flagged.cashCapitalPaymentsTotal) > 0 && (
        <Section
          title="Cash paid for assets"
          subtitle={formatCurrency(flagged.cashCapitalPaymentsTotal)}
        >
          <p className="px-5 py-4 text-xs leading-relaxed text-muted-foreground">
            Cash above the limit spent on an asset is not disallowed as
            expenditure — it simply does not count towards the cost of the asset
            for depreciation, under the proviso to section 43(1). It is
            separated out here rather than added to the figure above, because
            the consequence is different: less depreciation for as long as you
            hold the asset, rather than a one-off addition to this year&rsquo;s
            income.
          </p>
        </Section>
      )}

      {flagged.unpaidBills.length > 0 && (
        <Section
          title="Supplier bills unpaid past the time limit"
          subtitle={`${flagged.unpaidBills.length} ${flagged.unpaidBills.length === 1 ? "bill" : "bills"} · ${formatCurrency(flagged.unpaidBillsTotal)}`}
        >
          <div className="overflow-x-auto">
            <Table className="border-0">
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Supplier</TableHead>
                  <TableHead>Bill</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Age at year end</TableHead>
                  <TableHead className="pr-5 text-right">Outstanding</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {flagged.unpaidBills.map((bill) => (
                  <TableRow key={bill.number}>
                    <TableCell className="pl-5 text-sm">
                      {bill.supplierName}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {bill.number}
                    </TableCell>
                    <TableCell className="text-sm">
                      {formatDate(bill.date, { style: "short" })}
                    </TableCell>
                    <TableCell className="tabular-figures text-right text-sm">
                      {bill.daysAtYearEnd} days
                    </TableCell>
                    <Amount value={bill.outstanding} className="pr-5" />
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="border-t px-5 py-3 text-xs leading-relaxed text-muted-foreground">
            Section 43B(h) disallows what you owe a registered micro or small
            enterprise until you actually pay it. This platform does not know
            which of your suppliers are registered as such — that is on their
            invoice or on the Udyam portal — so this is exposure to check rather
            than an amount to add. It lists bills still unpaid today; one that
            was unpaid at the year end and settled since is caught just the
            same, so treat the figure as a floor.
          </p>
        </Section>
      )}

      {Number(paper.otherIncomeInBooks) > 0 && (
        <Section
          title="Income that may belong under another head"
          subtitle={formatCurrency(paper.otherIncomeInBooks)}
        >
          <p className="px-5 py-4 text-xs leading-relaxed text-muted-foreground">
            This much sits in other income in the profit and loss account.
            Interest on a deposit, rent from a property you own and a gain on
            selling an asset are taxed under their own heads rather than as
            business income, and moving them changes both this computation and
            what you can set against them. Whether any of this needs to move is
            a question about what it actually is.
          </p>
        </Section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Depreciation
// ---------------------------------------------------------------------------

function DepreciationPanel({ paper }: { paper: TaxWorkingPaper }) {
  const { depreciation } = paper;

  if (depreciation.blocks.length === 0) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-dashed px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            No fixed assets have been recorded, so there is nothing to
            depreciate. Assets appear here when an expense is recorded as
            capital expenditure.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Section
        title="Depreciation under the Act"
        subtitle="Written down value, on blocks of assets, at the prescribed rates"
      >
        <div className="overflow-x-auto">
          <Table className="border-0">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Block</TableHead>
                <TableHead className="text-right">Rate</TableHead>
                <TableHead className="text-right">Opening</TableHead>
                <TableHead className="text-right">Additions</TableHead>
                <TableHead className="text-right">Disposals</TableHead>
                <TableHead className="text-right">Depreciation</TableHead>
                <TableHead className="pr-5 text-right">Closing</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {depreciation.blocks.map((block) => (
                <TableRow key={`${block.label}-${block.ratePercent}`}>
                  <TableCell className="pl-5 text-sm">{block.label}</TableCell>
                  <TableCell className="text-right text-sm">
                    <Badge variant="muted">{block.ratePercent}%</Badge>
                  </TableCell>
                  <Amount value={block.openingWdv} />
                  <Amount
                    value={String(
                      Number(block.additionsFullRate) +
                        Number(block.additionsHalfRate),
                    )}
                  />
                  <Amount value={block.disposals} />
                  <Amount value={block.depreciation} />
                  <Amount value={block.closingWdv} className="pr-5" />
                </TableRow>
              ))}
              <TableRow className="bg-secondary/50">
                <TableCell className="pl-5 text-sm font-semibold">
                  Total
                </TableCell>
                <TableCell />
                <Amount value={depreciation.openingWdv} bold />
                <Amount value={depreciation.additions} bold />
                <Amount value={depreciation.disposals} bold />
                <Amount value={depreciation.depreciation} bold />
                <Amount value={depreciation.closingWdv} className="pr-5" bold />
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </Section>

      <Section
        title="Which block each asset went into"
        subtitle="A block is defined by its rate, so assets that share one are pooled"
      >
        <div className="overflow-x-auto">
          <Table className="border-0">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Asset</TableHead>
                <TableHead>Treated as</TableHead>
                <TableHead>Bought</TableHead>
                <TableHead className="text-right">Rate</TableHead>
                <TableHead className="pr-5 text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {depreciation.blocks.flatMap((block) =>
                block.assets.map((asset) => (
                  <TableRow key={asset.id}>
                    <TableCell className="pl-5 text-sm">
                      {asset.name}
                      {asset.halfRate && (
                        <Badge variant="muted" className="ml-2">
                          Half rate
                        </Badge>
                      )}
                      {asset.disposedThisYear && (
                        <Badge variant="muted" className="ml-2">
                          Sold
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {asset.blockLabel}
                      {asset.rateInferred && (
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          (guessed)
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {formatDate(asset.purchaseDate, { style: "short" })}
                    </TableCell>
                    <TableCell className="tabular-figures text-right text-sm">
                      {asset.ratePercent}%
                    </TableCell>
                    <Amount value={asset.purchaseCost} className="pr-5" />
                  </TableRow>
                )),
              )}
            </TableBody>
          </Table>
        </div>
      </Section>

      {depreciation.notes.map((note) => (
        <Note key={note}>{note}</Note>
      ))}

      <Note>
        This is not the depreciation in your books, and the two are not meant to
        agree. The books charged {formatCurrency(paper.bookDepreciation)} over
        the assets&rsquo; useful lives; the Act allows{" "}
        {formatCurrency(depreciation.depreciation)} on the written down value of
        the blocks. The computation adds the first back and takes the second
        instead.
      </Note>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section 44AD
// ---------------------------------------------------------------------------

function PresumptivePanel({ paper }: { paper: TaxWorkingPaper }) {
  const { presumptive, cashMix } = paper;
  const normal = Number(paper.taxableIncome);
  const deemed = Number(presumptive.incomeAtSplitRate);

  return (
    <div className="space-y-4">
      <Section
        title="Declaring a percentage of turnover instead"
        subtitle={
          presumptive.eligible
            ? "Available on this year's turnover"
            : "Not available this year"
        }
      >
        <dl className="divide-y">
          <SummaryLine label="Turnover" value={presumptive.turnover} />
          <SummaryLine
            label={`At ${RATE_ON_CASH}% of the whole turnover`}
            value={presumptive.incomeAtFullRate}
            note="The figure that holds whatever the receipt mix turns out to be."
          />
          <SummaryLine
            label={`At ${RATE_ON_DIGITAL}% on the banked part and ${RATE_ON_CASH}% on the rest`}
            value={presumptive.incomeAtSplitRate}
            note={`${formatPercent(presumptive.digitalSharePercent)} of the money that came in this year did so other than in cash.`}
          />
          <SummaryLine
            label="Against the income computed from your books"
            value={paper.taxableIncome}
            emphasis
          />
        </dl>

        {presumptive.eligible && (
          <div className="border-t px-5 py-3">
            <p className="text-sm leading-relaxed">
              {deemed > normal ? (
                <>
                  On these figures declaring under section 44AD would put{" "}
                  <span className="font-semibold">
                    {formatCurrency(deemed - normal)}
                  </span>{" "}
                  more into tax than your books do.
                </>
              ) : deemed < normal ? (
                <>
                  On these figures declaring under section 44AD would put{" "}
                  <span className="font-semibold">
                    {formatCurrency(normal - deemed)}
                  </span>{" "}
                  less into tax than your books do — at the cost of keeping to
                  the scheme, because declaring less than the presumptive rate
                  in any of the next five years takes it away and brings an
                  audit with it.
                </>
              ) : (
                <>On these figures the two come to the same income.</>
              )}
            </p>
          </div>
        )}
      </Section>

      <Section
        title="Whether it is available"
        subtitle="Turnover, legal form and receipt mix"
      >
        <ul className="space-y-2 px-5 py-4">
          {presumptive.reasons.map((reason) => (
            <li key={reason} className="flex items-start gap-2 text-sm">
              {presumptive.eligible ? (
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success-foreground" />
              ) : (
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
              )}
              <span className="leading-relaxed">{reason}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="How much of the money moved in cash"
        subtitle="Measured from the movement on your cash and bank accounts"
      >
        <div className="overflow-x-auto">
          <Table className="border-0">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5" />
                <TableHead className="text-right">In cash</TableHead>
                <TableHead className="text-right">Through a bank</TableHead>
                <TableHead className="pr-5 text-right">Cash share</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="pl-5 text-sm">Money in</TableCell>
                <Amount value={cashMix.cashReceipts} />
                <Amount value={cashMix.bankReceipts} />
                <TableCell className="tabular-figures pr-5 text-right text-sm">
                  {formatPercent(cashMix.cashReceiptSharePercent)}
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="pl-5 text-sm">Money out</TableCell>
                <Amount value={cashMix.cashPayments} />
                <Amount value={cashMix.bankPayments} />
                <TableCell className="tabular-figures pr-5 text-right text-sm">
                  {formatPercent(cashMix.cashPaymentSharePercent)}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
        <p className="border-t px-5 py-3 text-xs leading-relaxed text-muted-foreground">
          This share decides two separate things: whether the presumptive
          ceiling is ₹2 crore or ₹3 crore, and whether the audit threshold is ₹1
          crore or ₹10 crore. Both relaxations need cash to stay within 5%, and
          a shop that banks nearly everything is often entitled to them without
          knowing.
        </p>
      </Section>

      <Note>
        The split between the {RATE_ON_DIGITAL}% and {RATE_ON_CASH}% rates is
        applied in proportion to how the year&rsquo;s money actually came in,
        not traced invoice by invoice. Treat the {RATE_ON_CASH}% figure as the
        one that certainly holds and the split figure as the better case.
      </Note>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Advance tax and audit
// ---------------------------------------------------------------------------

function AdvanceTaxPanel({ paper }: { paper: TaxWorkingPaper }) {
  return (
    <div className="space-y-4">
      <Section title="Advance tax instalments" subtitle={paper.advanceTaxBasis}>
        {paper.advanceTax.length === 0 ? (
          <p className="px-5 py-6 text-center text-sm text-muted-foreground">
            Nothing to schedule.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table className="border-0">
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Due</TableHead>
                  <TableHead className="text-right">Cumulative</TableHead>
                  <TableHead className="text-right">By then</TableHead>
                  <TableHead className="pr-5 text-right">
                    This instalment
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paper.advanceTax.map((instalment) => (
                  <TableRow key={instalment.dueDate}>
                    <TableCell className="pl-5 text-sm">
                      {formatDate(instalment.dueDate, { style: "short" })}
                      {instalment.elapsed && (
                        <Badge variant="muted" className="ml-2">
                          Passed
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-sm">
                      {instalment.cumulativePercent}%
                    </TableCell>
                    <Amount value={instalment.cumulativeAmount} />
                    <Amount
                      value={instalment.instalmentAmount}
                      className="pr-5"
                    />
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <p className="border-t px-5 py-3 text-xs leading-relaxed text-muted-foreground">
          {paper.advanceTaxRequired
            ? "Advance tax is due where the liability for the year reaches ₹10,000. Falling short of an instalment carries interest under sections 234B and 234C, which is not worked out here."
            : "The estimated liability is under ₹10,000, so no advance tax appears to be due under section 208."}
        </p>
      </Section>

      <Section
        title="Whether the accounts need auditing"
        subtitle={`Turnover ${formatCurrency(paper.turnover)}`}
      >
        <div className="flex items-start gap-2 px-5 py-4">
          {paper.audit.required ? (
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          ) : (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success-foreground" />
          )}
          <div>
            <p className="text-sm leading-relaxed">{paper.audit.reason}</p>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              An audit can also be required for reasons that have nothing to do
              with turnover — declaring less than the presumptive rate after
              having opted into section 44AD is the common one. This looks at
              turnover and the cash share, and nothing else.
            </p>
          </div>
        </div>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function SummaryLine({
  label,
  value,
  note,
  emphasis,
}: {
  label: string;
  value: string;
  note?: string | null;
  emphasis?: boolean;
}) {
  return (
    <div
      className={`flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-5 py-3 ${
        emphasis ? "bg-secondary/50" : ""
      }`}
    >
      <dt className="min-w-0 flex-1">
        <span className={`text-sm ${emphasis ? "font-semibold" : ""}`}>
          {label}
        </span>
        {note && (
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {note}
          </p>
        )}
      </dt>
      <dd
        className={`tabular-figures shrink-0 text-right ${
          emphasis ? "text-base font-semibold" : "text-sm"
        }`}
      >
        {formatCurrency(value)}
      </dd>
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

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
      <Info className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
