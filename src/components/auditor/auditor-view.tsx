"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Info,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { RULES, SCORE_DISCLAIMER, type Severity } from "@/lib/auditor/rules";
import { runAuditAction, settleFindingAction } from "@/server/auditor/actions";
import type {
  AuditReport,
  StoredFinding,
} from "@/server/auditor/audit-service";

/**
 * The auditor.
 *
 * Findings are observations, and the page reads like one. Every finding shows
 * the evidence that made it fire and the ordinary reasons it happens, because
 * almost all of these have an innocent cause more likely than a dishonest one —
 * and a small business owner reading a list of alarms about their own shop
 * deserves the other half of the sentence.
 *
 * Nothing here was produced by a model. The checks are queries, the severities
 * are fixed, and the score is arithmetic on them.
 */

const SEVERITY_LABEL: Record<Severity, string> = {
  CRITICAL: "Critical",
  HIGH: "Worth looking at now",
  MEDIUM: "Worth a look",
  LOW: "For information",
  INFO: "For information",
};

const SEVERITY_VARIANT: Record<Severity, "warning" | "muted"> = {
  CRITICAL: "warning",
  HIGH: "warning",
  MEDIUM: "muted",
  LOW: "muted",
  INFO: "muted",
};

export function AuditorView({ report }: { report: AuditReport }) {
  const router = useRouter();
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    const result = await runAuditAction();
    setRunning(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl border px-5 py-4">
        <p className="flex items-center gap-2 text-sm font-medium">
          <ShieldCheck className="size-4" />
          Observations, not allegations
        </p>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          These checks describe what your books show. Almost every one of them
          has an ordinary explanation that is more likely than anything else,
          and each finding carries those explanations with it. Nothing here
          concludes that anyone has done anything wrong — a set of database
          queries is not in a position to know that.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-muted-foreground">
          {report.run ? (
            <>
              Last run {formatDateTime(report.run.startedAt)} · rules{" "}
              {report.run.rulesVersion}
            </>
          ) : (
            <>These checks have not been run yet.</>
          )}
        </div>
        <Button onClick={() => void run()} disabled={running}>
          {running ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ShieldCheck className="size-4" />
          )}
          {running ? "Checking…" : "Run the checks"}
        </Button>
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {report.run && <ScorePanel report={report} />}

      {report.run?.incomplete.length ? (
        <div className="rounded-xl border border-warning/40 bg-warning/5 px-5 py-4">
          <p className="flex items-center gap-2 text-sm font-medium">
            <AlertTriangle className="size-4" />
            Some checks could not be completed
          </p>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
            {report.run.incomplete.join(", ")}. The rest ran, and what they
            found is below — an audit that returned nothing because one query
            failed would be worse than one that says which.
          </p>
        </div>
      ) : null}

      {report.findings.length === 0 ? (
        report.run ? (
          <div className="flex items-start gap-2 rounded-xl border px-5 py-4">
            {report.run.partial ? (
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
            ) : (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success-foreground" />
            )}
            <p className="text-sm leading-relaxed">
              {report.run.partial ? (
                <>
                  The checks that ran found nothing — but not all of them ran,
                  so this is not a clean result. It says only that the checks
                  listed above were not the ones that looked.
                </>
              ) : (
                <>
                  Nothing in your books trips any of these checks. That is not
                  the same as everything being right — a purchase recorded
                  against Rent passes every one of them and is still wrong.
                </>
              )}
            </p>
          </div>
        ) : null
      ) : (
        <div className="space-y-3">
          {report.findings.map((finding) => (
            <FindingCard key={finding.id} finding={finding} />
          ))}
        </div>
      )}

      {report.settled.length > 0 && <SettledPanel findings={report.settled} />}

      <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        <span>
          These are the checks a set of books can answer on its own. Passing
          them is not an audit in the statutory sense, and it is not a
          substitute for one.
        </span>
      </p>
    </div>
  );
}

function ScorePanel({ report }: { report: AuditReport }) {
  const run = report.run;
  if (!run) return null;

  return (
    <div className="overflow-hidden rounded-xl border">
      <div className="flex flex-wrap items-baseline justify-between gap-4 px-5 py-4">
        <div>
          <p className="text-xs text-muted-foreground">
            {run.periodStart} to {run.periodEnd}
          </p>
          <p className="mt-1 flex items-baseline gap-3">
            <span className="tabular-figures text-3xl font-semibold">
              {run.score}
            </span>
            <span className="text-sm text-muted-foreground">out of 100</span>
            <Badge variant={SEVERITY_VARIANT[run.riskLevel]}>
              {SEVERITY_LABEL[run.riskLevel]}
            </Badge>
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          {run.findingsCount === 0
            ? "Nothing found"
            : `${run.findingsCount} ${run.findingsCount === 1 ? "finding" : "findings"}`}
        </p>
      </div>
      <p className="border-t px-5 py-3 text-xs leading-relaxed text-muted-foreground">
        {run.partial ? (
          <>
            <span className="font-medium text-warning-foreground">
              This score covers only the checks that ran.
            </span>{" "}
          </>
        ) : null}
        {SCORE_DISCLAIMER} It starts at 100 and each finding takes off a fixed
        amount for its severity, so you can work it out yourself.
      </p>
    </div>
  );
}

function FindingCard({ finding }: { finding: StoredFinding }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);

  async function settle(status: string) {
    setPending(true);
    const form = new FormData();
    form.set("findingId", finding.id);
    form.set("status", status);
    await settleFindingAction(null, form);
    setPending(false);
    router.refresh();
  }

  return (
    <div className="overflow-hidden rounded-xl border">
      <div className="px-5 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h3 className="text-sm font-semibold">{finding.title}</h3>
          <Badge variant={SEVERITY_VARIANT[finding.severity]}>
            {SEVERITY_LABEL[finding.severity]}
          </Badge>
        </div>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          {finding.description}
        </p>

        {finding.recommendation && (
          <p className="mt-2 text-sm leading-relaxed">
            {finding.recommendation}
          </p>
        )}

        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-4 hover:underline"
          aria-expanded={open}
        >
          What made this fire, and why it usually happens
          <ChevronDown
            className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>

        {open && (
          <div className="mt-3 space-y-3">
            <dl className="grid gap-x-6 gap-y-1 rounded-lg border px-4 py-3 text-xs sm:grid-cols-2">
              {Object.entries(finding.evidence).map(([key, value]) => (
                <div
                  key={key}
                  className="flex items-baseline justify-between gap-3"
                >
                  <dt className="text-muted-foreground">{humanise(key)}</dt>
                  <dd className="tabular-figures text-right font-medium">
                    {renderValue(value)}
                  </dd>
                </div>
              ))}
            </dl>

            <div>
              <p className="text-xs font-medium">
                This usually happens because:
              </p>
              <ul className="mt-1 space-y-1">
                {(
                  finding.ordinaryExplanations ??
                  RULES[finding.ruleKey]?.ordinaryExplanations ??
                  []
                ).map((explanation) => (
                  <li
                    key={explanation}
                    className="text-xs leading-relaxed text-muted-foreground"
                  >
                    • {explanation}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2 border-t px-5 py-3">
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => void settle("ACKNOWLEDGED")}
        >
          I have seen this
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => void settle("RESOLVED")}
        >
          Sorted
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => void settle("FALSE_POSITIVE")}
        >
          Not a problem here
        </Button>
      </div>
    </div>
  );
}

function SettledPanel({ findings }: { findings: StoredFinding[] }) {
  return (
    <div className="overflow-hidden rounded-xl border">
      <div className="border-b px-5 py-3.5">
        <h3 className="text-sm font-semibold">Already dealt with</h3>
        <p className="text-xs text-muted-foreground">
          Kept, not deleted. A judgement about a finding is worth more than the
          finding.
        </p>
      </div>
      <ul className="divide-y">
        {findings.map((finding) => (
          <li
            key={finding.id}
            className="flex flex-wrap items-baseline justify-between gap-3 px-5 py-2.5"
          >
            <span className="text-sm">{finding.title}</span>
            <Badge variant="muted">{humanise(finding.status)}</Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** `firstDate` reads as "First date" rather than as a column name. */
function humanise(key: string): string {
  const spaced = key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function renderValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  if (value === null || value === undefined) return "—";
  return String(value);
}
