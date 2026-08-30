import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { JournalForm } from "@/components/accounting/journal-form";
import { requirePermission } from "@/server/auth/context";
import { postableAccounts } from "@/server/accounting/journal-service";
import { businessToday } from "@/lib/validation/date";

export const metadata: Metadata = {
  title: "New journal entry",
  robots: { index: false, follow: false },
};

/**
 * Posting an entry by hand.
 *
 * Deliberately not the main way to record anything. A sale entered here instead
 * of as an invoice moves the ledger without moving the stock, without a GST
 * register row and without a document to show anyone — so the page says what it
 * is for, and what it is not.
 */
export default async function NewJournalEntryPage() {
  const context = await requirePermission("accounting.journal.create");
  const accounts = await postableAccounts(context.company.id);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <Link
        href="/app/accounting/journal"
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        <ArrowLeft className="size-3.5" />
        Journal
      </Link>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          New journal entry
        </h1>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          For the things that are only accounting — depreciation, an accrual, a
          bad debt written off, a correction. A sale or a purchase belongs in
          its own module: entered here it would move the ledger without moving
          the stock or the tax registers, and nothing would show that it
          happened.
        </p>
      </header>

      <JournalForm
        today={businessToday(context.company.timezone)}
        accounts={accounts.map((account) => ({
          id: account.id,
          code: account.code,
          name: account.name,
          groupName: account.groupName,
          partyType: account.partyType,
        }))}
      />
    </div>
  );
}
