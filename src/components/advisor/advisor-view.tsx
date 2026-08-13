"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Info,
  Lightbulb,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/format";
import { RANGE_KEYS, RANGE_LABELS, type RangeKey } from "@/lib/analytics/range";
import {
  ADVISOR_DISCLAIMER,
  CATEGORY_LABEL,
  EFFORT_LABEL,
  PROFESSIONAL_NOTE,
  RULES,
  type Urgency,
} from "@/lib/advisor/catalogue";
import type { Impact, Suggestion } from "@/lib/advisor/impact";
import type { AdviceReport } from "@/server/advisor/advisor-service";

/**
 * The advisor.
 *
 * Every suggestion is laid out the same way: what the books show, what it is
 * worth, what to do, and — given equal room — when it does not apply. The last
 * of those is not a disclaimer tucked underneath. A shopkeeper who knows their
 * trade will often read a suggestion and be right to ignore it, and the page is
 * built for that reader rather than against them.
 */

const URGENCY_LABEL: Record<Urgency, string> = {
  NOW: "This week",
  SOON: "Soon",
  WHEN_YOU_CAN: "When you can",
};

const URGENCY_VARIANT: Record<Urgency, "warning" | "muted"> = {
  NOW: "warning",
  SOON: "muted",
  WHEN_YOU_CAN: "muted",
};

export function AdvisorView({ report }: { report: AdviceReport }) {
  return (
    <div className="space-y-5">
      <div className="rounded-xl border px-5 py-4">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Lightbulb className="size-4" />
          Worked out from your books, not from a model
        </p>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          {ADVISOR_DISCLAIMER}
        </p>
      </div>

      <RangePicker current={report.range} />

      {report.incomplete.length > 0 && (
        <div className="rounded-xl border border-warning/40 bg-warning/5 px-5 py-4">
          <p className="flex items-center gap-2 text-sm font-medium">
            <AlertTriangle className="size-4" />
            Part of the picture is missing
          </p>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
            {report.incomplete.join(", ")} could not be read, so anything that
            depends on it is not in this list. A short list is not the same as a
            clean one.
          </p>
        </div>
      )}

      {report.empty ? (
        <EmptyState />
      ) : report.suggestions.length === 0 ? (
        <NothingToSay />
      ) : (
        <div className="space-y-3">
          {report.suggestions.map((suggestion) => (
            <SuggestionCard key={suggestion.key} suggestion={suggestion} />
          ))}
        </div>
      )}

      <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        <span>
          {report.rangeLabel}, {report.from} to {report.to} · suggestion set{" "}
          {report.catalogueVersion}. The same books produce the same suggestions
          every time — nothing here is generated afresh, so anything you
          disagree with is worth arguing with rather than re-running.
        </span>
      </p>
    </div>
  );
}

function RangePicker({ current }: { current: RangeKey }) {
  const router = useRouter();
  const params = useSearchParams();

  return (
    <div className="flex flex-wrap gap-2">
      {RANGE_KEYS.map((key) => (
        <Button
          key={key}
          size="sm"
          variant={key === current ? "default" : "outline"}
          onClick={() => {
            const next = new URLSearchParams(params.toString());
            next.set("range", key);
            router.push(`/app/ai/advisor?${next.toString()}`);
          }}
        >
          {RANGE_LABELS[key]}
        </Button>
      ))}
    </div>
  );
}

function SuggestionCard({ suggestion }: { suggestion: Suggestion }) {
  const rule = RULES[suggestion.key];
  const [open, setOpen] = React.useState(false);

  return (
    <div className="overflow-hidden rounded-xl border">
      <div className="px-5 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h3 className="text-sm font-semibold">{rule.title}</h3>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="muted">{CATEGORY_LABEL[rule.category]}</Badge>
            <Badge variant={URGENCY_VARIANT[suggestion.urgency]}>
              {URGENCY_LABEL[suggestion.urgency]}
            </Badge>
          </div>
        </div>

        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          {suggestion.observation}
        </p>

        <ImpactLine impact={suggestion.impact} />

        {suggestion.escalated && (
          <p className="mt-2 text-xs text-muted-foreground">
            Moved up the list because of the size of it against your turnover,
            not because anything about it changed.
          </p>
        )}

        <p className="mt-3 text-sm leading-relaxed">{rule.whatToDo}</p>

        {rule.needsProfessional && (
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {PROFESSIONAL_NOTE}
          </p>
        )}

        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-4 hover:underline"
          aria-expanded={open}
        >
          When this does not apply, and where the figures came from
          <ChevronDown
            className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>

        {open && (
          <div className="mt-3 space-y-3">
            <div>
              <p className="text-xs font-medium">
                You may be right to ignore this if:
              </p>
              <ul className="mt-1 space-y-1">
                {rule.whenThisDoesNotApply.map((caveat) => (
                  <li
                    key={caveat}
                    className="text-xs leading-relaxed text-muted-foreground"
                  >
                    • {caveat}
                  </li>
                ))}
              </ul>
            </div>

            <dl className="grid gap-x-6 gap-y-1 rounded-lg border px-4 py-3 text-xs sm:grid-cols-2">
              {Object.entries(suggestion.evidence).map(([key, value]) => (
                <div
                  key={key}
                  className="flex items-baseline justify-between gap-3"
                >
                  <dt className="text-muted-foreground">{humanise(key)}</dt>
                  <dd className="tabular-figures text-right font-medium">
                    {String(value)}
                  </dd>
                </div>
              ))}
            </dl>

            <p className="text-xs leading-relaxed text-muted-foreground">
              {rule.basis}
            </p>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-5 py-3">
        <span className="text-xs text-muted-foreground">
          Roughly {EFFORT_LABEL[rule.effort].toLowerCase()} of your time
        </span>
        <Button asChild size="sm" variant="outline">
          <Link href={DESTINATION[suggestion.key]}>Go and look</Link>
        </Button>
      </div>
    </div>
  );
}

/** Where the figures behind each suggestion can be checked. */
const DESTINATION: Record<Suggestion["key"], string> = {
  OVERDUE_RECEIVABLES: "/app/receipts",
  CASH_SHORTFALL_AHEAD: "/app/forecasting",
  SLOW_MOVING_STOCK: "/app/inventory",
  STOCK_OUT_RISK: "/app/inventory",
  LOW_MARGIN_PRODUCT: "/app/analytics",
  MARGIN_SLIPPING: "/app/analytics",
  CUSTOMER_CONCENTRATION: "/app/analytics",
  EXPENSE_GROWING_FASTER_THAN_SALES: "/app/expenses",
  SHORT_ON_WORKING_CAPITAL: "/app/accounting/statements",
  CASH_TIED_UP_TOO_LONG: "/app/analytics",
};

/**
 * What it is worth, said as precisely as it can honestly be said — which for an
 * estimate means a band and the assumption behind it, and for something nobody
 * could know means saying that instead of a number.
 */
function ImpactLine({ impact }: { impact: Impact }) {
  if (impact.kind === "recorded") {
    return (
      <p className="mt-2 text-sm">
        <span className="tabular-figures font-semibold">
          {formatCurrency(impact.amount, { compactZeroDecimals: true })}
        </span>{" "}
        <span className="text-muted-foreground">{impact.what}</span>
      </p>
    );
  }

  if (impact.kind === "estimated") {
    return (
      <p className="mt-2 text-sm">
        <span className="tabular-figures font-semibold">
          {formatCurrency(impact.low, { compactZeroDecimals: true })} to{" "}
          {formatCurrency(impact.high, { compactZeroDecimals: true })}
        </span>{" "}
        <span className="text-muted-foreground">{impact.assumption}</span>
      </p>
    );
  }

  return (
    <p className="mt-2 text-sm text-muted-foreground">
      There is no honest figure for {impact.why}.
    </p>
  );
}

function NothingToSay() {
  return (
    <div className="flex items-start gap-2 rounded-xl border px-5 py-4">
      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success-foreground" />
      <p className="text-sm leading-relaxed">
        Nothing in this period trips any of these. That is not the same as
        nothing being worth doing — these are the handful of things a set of
        books can notice on its own, and most of what makes a shop better is not
        in them.
      </p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed px-6 py-14 text-center">
      <h2 className="text-base font-semibold">Nothing has been sold yet</h2>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
        Suggestions are worked out from what you have recorded. Record a few
        sales and bills and this fills itself in.
      </p>
    </div>
  );
}

function humanise(key: string): string {
  const spaced = key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
