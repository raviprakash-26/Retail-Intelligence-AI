import type { Metadata } from "next";
import { Download, ShieldCheck } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { WITHHELD_MODELS } from "@/lib/export/manifest";
import { requirePermission } from "@/server/auth/context";
import { exportPlan } from "@/server/company/data-export";

export const metadata: Metadata = {
  title: "Your data",
  robots: { index: false, follow: false },
};

/**
 * Taking the books out.
 *
 * The page says what the file contains before anybody downloads it, including
 * what it does not contain and why. A shop deciding whether this product can
 * hold its records should be able to see the answer without having to try it,
 * and an accountant told "here is everything" ought to be able to check.
 */
export default async function DataSettingsPage() {
  const context = await requirePermission("data.export");
  const tables = exportPlan();
  const columns = tables.reduce((sum, table) => sum + table.fields.length, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Your data</h1>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          Everything {context.company.name} has recorded here, as a zip of CSV
          files — one per table, readable in Excel, Google Sheets or Tally.
          These are your books. You can take them somewhere else, hand them to
          your accountant, or keep a copy against the day somebody asks for
          records from six years ago.
        </p>
      </div>

      <div className="rounded-xl border">
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div>
            <p className="text-sm font-medium">
              {tables.length} files, {columns} columns
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Amounts are exact. Nothing is rounded on the way out.
            </p>
          </div>
          <Button asChild>
            <a href="/app/settings/data/export" download>
              <Download aria-hidden="true" />
              Download everything
            </a>
          </Button>
        </div>
        <p className="border-t px-5 py-3 text-xs leading-relaxed text-muted-foreground">
          A large business may take a minute or two — the file is built as it
          downloads. A few exports an hour is the limit, and each one is
          recorded in the activity log.
        </p>
      </div>

      <Alert variant="info">
        <ShieldCheck />
        <AlertTitle>What the file will not contain</AlertTitle>
        <AlertDescription>
          <p>
            Sign-in credentials are never exported, in any file. Nor is anything
            below — the reasons are repeated inside the archive so whoever opens
            it can see them too.
          </p>
          <ul className="mt-2 space-y-1">
            {Object.entries(WITHHELD_MODELS).map(([model, reason]) => (
              <li key={model} className="text-sm">
                <span className="font-medium">{model}</span> — {reason}
              </li>
            ))}
          </ul>
        </AlertDescription>
      </Alert>

      <p className="text-xs leading-relaxed text-muted-foreground">
        These are the figures as recorded. Nothing here has been filed with any
        authority, and an export is not a statutory return.
      </p>
    </div>
  );
}
