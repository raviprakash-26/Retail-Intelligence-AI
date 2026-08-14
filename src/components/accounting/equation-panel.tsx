import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { formatCurrency } from "@/lib/format";

/**
 * The accounting equation, checked against the real ledger.
 *
 * Assets = Liabilities + Capital + (Income − Expenses). This is not decoration:
 * it is the one assertion that says the books hold together, computed from the
 * same balances every statement is built from. If it were ever untrue, every
 * report downstream would be wrong and this is where it would show first.
 *
 * It is shown rather than merely asserted because a retailer who can see their
 * own books balance has a reason to trust the figures on every other page.
 */
export function EquationPanel({
  equation,
  asOfLabel,
}: {
  equation: {
    assets: string;
    liabilities: string;
    equity: string;
    profit: string;
    difference: string;
    balanced: boolean;
  };
  asOfLabel: string;
}) {
  const balanced = equation.balanced;
  const rightSide =
    Number(equation.liabilities) +
    Number(equation.equity) +
    Number(equation.profit);

  return (
    <div className="mb-6 rounded-xl border px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Does it balance?</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Every entry, {asOfLabel}.
          </p>
        </div>
        <span
          className={
            balanced
              ? "flex items-center gap-1.5 text-sm font-medium text-success-foreground"
              : "flex items-center gap-1.5 text-sm font-medium text-destructive"
          }
        >
          {balanced ? (
            <CheckCircle2 className="size-4" />
          ) : (
            <AlertTriangle className="size-4" />
          )}
          {balanced
            ? "Balanced"
            : "Out by " + formatCurrency(equation.difference)}
        </span>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto_1fr]">
        <Side
          label="What the business owns"
          sublabel="Assets"
          value={equation.assets}
        />
        <div className="hidden items-center justify-center text-lg font-medium text-muted-foreground sm:flex">
          =
        </div>
        <Side
          label="What it owes, plus your stake"
          sublabel="Liabilities + capital + profit"
          value={String(rightSide)}
        />
      </div>

      <dl className="mt-4 grid gap-x-6 gap-y-1.5 border-t pt-3 text-sm sm:grid-cols-3">
        <Row label="Owed to others" value={equation.liabilities} />
        <Row label="Your capital" value={equation.equity} />
        <Row label="Earned so far" value={equation.profit} />
      </dl>

      {!balanced && (
        <p className="mt-3 text-xs leading-relaxed text-destructive">
          The ledger does not balance. This should be impossible — every entry
          is checked when it is posted and again by the database — so it points
          at data changed outside the application rather than at anything you
          did. Nothing else on this page can be relied on until it is
          investigated.
        </p>
      )}
    </div>
  );
}

function Side({
  label,
  sublabel,
  value,
}: {
  label: string;
  sublabel: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="tabular-figures mt-0.5 text-xl font-semibold">
        {formatCurrency(value, { compactZeroDecimals: true })}
      </p>
      <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">
        {sublabel}
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-figures">
        {formatCurrency(value, { compactZeroDecimals: true })}
      </dd>
    </div>
  );
}
