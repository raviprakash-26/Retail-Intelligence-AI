import { Info } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency, formatDate, formatNumber } from "@/lib/format";
import type {
  ReportColumn,
  ReportResult,
  ReportRow,
} from "@/lib/reports/result";
import { cn } from "@/lib/utils";

/**
 * A report on screen.
 *
 * Cells arrive as the exact strings the source service produced and are
 * formatted here, at the last possible moment. Formatting earlier would mean
 * the CSV either carried "₹1,04,522.00" — which no spreadsheet will add up —
 * or a second, differently-rounded copy of every figure.
 *
 * The notes are rendered as prominently as the table. On a report whose whole
 * job is to be believed, the sentence explaining that a GST summary has not
 * been filed is not a footnote.
 */

function renderCell(value: string | undefined, column: ReportColumn): string {
  if (!value) return "";
  switch (column.kind) {
    case "money":
      return formatCurrency(value);
    case "number":
      return formatNumber(value);
    case "date":
      return formatDate(value, { style: "short" });
    default:
      return value;
  }
}

const ALIGNED_RIGHT = new Set(["money", "number"]);

function RowCells({
  entry,
  columns,
}: {
  entry: ReportRow;
  columns: readonly ReportColumn[];
}) {
  return (
    <>
      {columns.map((column) => {
        const raw = entry.cells[column.key];
        return (
          <td
            key={column.key}
            className={cn(
              "px-3 py-1.5",
              ALIGNED_RIGHT.has(column.kind) && "tabular-figures text-right",
              entry.emphasis === "group" && "font-semibold",
              entry.emphasis === "total" && "font-medium",
            )}
          >
            {renderCell(raw, column)}
          </td>
        );
      })}
    </>
  );
}

export function ReportView({ report }: { report: ReportResult }) {
  return (
    <div className="space-y-5">
      {report.empty ? (
        <div className="rounded-xl border border-dashed px-6 py-14 text-center">
          <h2 className="text-base font-semibold">Nothing to report</h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">
            There is no activity in this period. That is an answer, not a
            failure — change the dates to look somewhere else.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <caption className="sr-only">
              {report.title}, {report.period}
            </caption>
            <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
              <tr>
                {report.columns.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    className={cn(
                      "px-3 py-2 text-left font-medium",
                      ALIGNED_RIGHT.has(column.kind) && "text-right",
                    )}
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.rows.map((entry, index) => (
                <tr
                  key={index}
                  className={cn(
                    "border-b last:border-0",
                    entry.emphasis === "group" && "bg-muted/30",
                    entry.emphasis === "total" && "border-t",
                  )}
                >
                  <RowCells entry={entry} columns={report.columns} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {report.notes.length > 0 && (
        <Card>
          <CardContent className="flex gap-3 py-4 text-sm">
            <Info
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <ul className="space-y-1.5 leading-relaxed text-muted-foreground">
              {report.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
