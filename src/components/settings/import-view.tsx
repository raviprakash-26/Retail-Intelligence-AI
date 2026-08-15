"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, FileUp, Info } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DATASETS, type DatasetKey } from "@/lib/import/datasets";
import type {
  ImportPreview,
  ImportResult,
} from "@/server/import/import-service";
import {
  commitImportAction,
  previewImportAction,
} from "@/server/import/actions";

/**
 * Bringing a file in.
 *
 * Two steps on purpose, and the first one writes nothing. A person uploading
 * four hundred products with opening balances attached should see what would
 * happen before it does — which rows would be created, which are already here,
 * and exactly which row and column is wrong where something is. An import that
 * fails at row 300 and leaves somebody unable to say which half arrived is the
 * failure this shape exists to prevent.
 */

const ROWS_SHOWN = 50;

export function ImportView({ datasets }: { datasets: DatasetKey[] }) {
  const router = useRouter();
  const [dataset, setDataset] = React.useState<DatasetKey>(
    datasets[0] ?? "products",
  );
  const [text, setText] = React.useState<string>("");
  const [filename, setFilename] = React.useState<string>("");
  const [preview, setPreview] = React.useState<ImportPreview | null>(null);
  const [result, setResult] = React.useState<ImportResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  const definition = DATASETS[dataset];

  const reset = () => {
    setPreview(null);
    setResult(null);
    setError(null);
  };

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    reset();
    setFilename(file.name);
    const content = await file.text();
    setText(content);

    setPending(true);
    const outcome = await previewImportAction({ dataset, text: content });
    setPending(false);
    if (outcome.ok) setPreview(outcome.data);
    else setError(outcome.message);
  }

  async function onCommit() {
    setPending(true);
    setError(null);
    const outcome = await commitImportAction({ dataset, text });
    setPending(false);
    if (outcome.ok) {
      setResult(outcome.data);
      setPreview(null);
      router.refresh();
    } else {
      setError(outcome.message);
    }
  }

  function downloadTemplate() {
    // Built here rather than fetched: it is three lines of constant text, and
    // a round trip to be told what we already know would be silly.
    const blob = new Blob([`﻿${definition.template.join("\n")}\n`], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${dataset}-template.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Bring data in</h1>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          Moving from another system, or starting with a spreadsheet? Upload it
          here rather than typing it in. Nothing is saved until you have seen
          exactly what would be created.
        </p>
      </div>

      <div
        role="group"
        aria-label="What to bring in"
        className="flex flex-wrap gap-2"
      >
        {datasets.map((key) => (
          <Button
            key={key}
            type="button"
            variant={key === dataset ? "default" : "outline"}
            size="sm"
            aria-pressed={key === dataset}
            onClick={() => {
              setDataset(key);
              setText("");
              setFilename("");
              reset();
            }}
          >
            {DATASETS[key].title}
          </Button>
        ))}
      </div>

      <div className="rounded-xl border">
        <div className="space-y-3 px-5 py-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            {definition.note}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={downloadTemplate}
            >
              Download a template
            </Button>
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium hover:bg-accent">
              <FileUp className="size-4" aria-hidden="true" />
              Choose a CSV file
              <input
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                onChange={onFile}
              />
            </label>
            {filename && (
              <span className="text-sm text-muted-foreground">{filename}</span>
            )}
          </div>
        </div>
      </div>

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertTriangle />
          <AlertTitle>That file could not be brought in</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {pending && (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          Reading the file…
        </p>
      )}

      {result && (
        <Alert variant="success" role="status">
          <CheckCircle2 />
          <AlertTitle>Done</AlertTitle>
          <AlertDescription>
            <p>
              {result.created} created, {result.skipped} already here
              {result.failed.length > 0
                ? `, ${result.failed.length} could not be brought in`
                : ""}
              .
            </p>
            {result.failed.length > 0 && (
              <ul className="mt-2 space-y-1">
                {result.failed.map((issue) => (
                  <li key={issue.row} className="text-sm">
                    Row {issue.row}: {issue.message}
                  </li>
                ))}
              </ul>
            )}
          </AlertDescription>
        </Alert>
      )}

      {preview && (
        <Preview preview={preview} onCommit={onCommit} pending={pending} />
      )}
    </div>
  );
}

function Preview({
  preview,
  onCommit,
  pending,
}: {
  preview: ImportPreview;
  onCommit: () => void;
  pending: boolean;
}) {
  if (preview.missingColumns.length > 0) {
    return (
      <Alert variant="warning">
        <AlertTriangle />
        <AlertTitle>This file is missing a column</AlertTitle>
        <AlertDescription>
          <p>
            It has no column for{" "}
            <span className="font-medium">
              {preview.missingColumns.join(", ")}
            </span>
            . Add the heading and upload it again — the template shows the
            headings this reads.
          </p>
        </AlertDescription>
      </Alert>
    );
  }

  const shown = preview.rows.slice(0, ROWS_SHOWN);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border px-5 py-4">
        <p className="text-sm">
          <span className="font-semibold">{preview.counts.create}</span> to
          create, <span className="font-semibold">{preview.counts.skip}</span>{" "}
          already here
          {preview.counts.error > 0 && (
            <>
              ,{" "}
              <span className="font-semibold text-destructive">
                {preview.counts.error}
              </span>{" "}
              with problems
            </>
          )}
          .
        </p>
        <div className="ml-auto">
          <Button
            type="button"
            onClick={onCommit}
            disabled={!preview.ready || pending}
          >
            {preview.ready
              ? `Bring in ${preview.counts.create} ${preview.counts.create === 1 ? "row" : "rows"}`
              : "Fix the problems first"}
          </Button>
        </div>
      </div>

      {preview.unusedColumns.length > 0 && (
        <Alert variant="info">
          <Info />
          <AlertTitle>Some columns will not be used</AlertTitle>
          <AlertDescription>
            <p>
              {preview.unusedColumns.join(", ")} — nothing here keeps those, so
              they will be ignored rather than lost silently.
            </p>
          </AlertDescription>
        </Alert>
      )}

      {preview.issues.length > 0 && (
        <div className="rounded-xl border border-destructive/25 bg-destructive-muted px-5 py-4">
          <p className="text-sm font-medium">What needs fixing</p>
          <ul className="mt-2 space-y-1">
            {preview.issues.slice(0, ROWS_SHOWN).map((issue) => (
              <li key={`${issue.row}-${issue.column}`} className="text-sm">
                <span className="font-medium">Row {issue.row}</span>
                {issue.column ? ` · ${issue.column}` : ""} — {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">
              What each row of the file would do
            </caption>
            <thead className="border-b bg-muted/40">
              <tr>
                <th scope="col" className="px-4 py-2 text-left font-medium">
                  Row
                </th>
                <th scope="col" className="px-4 py-2 text-left font-medium">
                  What it is
                </th>
                <th scope="col" className="px-4 py-2 text-left font-medium">
                  What would happen
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {shown.map((row) => (
                <tr key={row.row}>
                  <td className="tabular-figures px-4 py-2">{row.row}</td>
                  <td className="px-4 py-2">{row.label}</td>
                  <td className="px-4 py-2">
                    {row.outcome === "create" && (
                      <Badge variant="success">Create</Badge>
                    )}
                    {row.outcome === "skip" && (
                      <Badge variant="muted">
                        Skip — {row.reason ?? "already here"}
                      </Badge>
                    )}
                    {row.outcome === "error" && (
                      <Badge variant="danger">Needs fixing</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {preview.rows.length > shown.length && (
          <p className="border-t px-4 py-2 text-xs text-muted-foreground">
            Showing the first {ROWS_SHOWN} of {preview.rows.length} rows. All of
            them are counted above.
          </p>
        )}
      </div>
    </div>
  );
}
