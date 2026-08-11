"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Info, Plus, Trash2 } from "lucide-react";
import { FormError } from "@/components/auth/form-error";
import { useServerFormErrors } from "@/components/auth/use-action-form";
import { AmountInput } from "@/components/ui/amount-input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { formatCurrency } from "@/lib/format";
import {
  EMPTY_JOURNAL_LINE,
  journalEntrySchema,
  MANUAL_VOUCHER_LABELS,
  MANUAL_VOUCHER_TYPES,
  type JournalEntryInput,
} from "@/lib/validation/journal";
import { cn } from "@/lib/utils";
import {
  createJournalEntryAction,
  journalPartiesAction,
} from "@/server/accounting/journal-actions";
import { AccountPicker, type PickerAccount } from "./account-picker";

/**
 * Posting an entry by hand.
 *
 * The running totals at the bottom are the point of the whole screen. An
 * accountant works out the entry as they type it, and a form that only reveals
 * "debits do not equal credits" after a failed submit makes them hunt for a
 * figure they already know. So the difference is shown live, named in the
 * direction it is out by, and the button stays disabled until it is nil.
 *
 * The same schema runs here and on the server, and the server posts through the
 * same engine every other module uses. Nothing about an entry typed by a person
 * is checked more loosely than one derived from an invoice.
 */
export function JournalForm({ accounts }: { accounts: PickerAccount[] }) {
  const router = useRouter();

  const form = useForm<JournalEntryInput>({
    resolver: zodResolver(journalEntrySchema),
    defaultValues: {
      entryDate: new Date().toISOString().slice(0, 10),
      voucherType: "JOURNAL",
      narration: "",
      referenceNo: "",
      lines: [{ ...EMPTY_JOURNAL_LINE }, { ...EMPTY_JOURNAL_LINE }],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "lines",
  });

  const { formError, applyResult } = useServerFormErrors(form);
  const lines = form.watch("lines");
  const voucherType = form.watch("voucherType");

  const accountsById = React.useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts],
  );

  // Parties are loaded once, the first time a control account is chosen.
  const [customers, setCustomers] = React.useState<
    Array<{ id: string; name: string }>
  >([]);
  const [suppliers, setSuppliers] = React.useState<
    Array<{ id: string; name: string }>
  >([]);
  const loading = React.useRef({ CUSTOMER: false, SUPPLIER: false });

  async function ensureParties(kind: "CUSTOMER" | "SUPPLIER") {
    if (loading.current[kind]) return;
    loading.current[kind] = true;
    const found = await journalPartiesAction(kind);
    if (kind === "CUSTOMER") setCustomers(found);
    else setSuppliers(found);
  }

  const totals = lines.reduce(
    (running, line) => ({
      debit: running.debit + (Number(line?.debit) || 0),
      credit: running.credit + (Number(line?.credit) || 0),
    }),
    { debit: 0, credit: 0 },
  );
  const difference = Math.round((totals.debit - totals.credit) * 100) / 100;
  const hasValue = totals.debit > 0 || totals.credit > 0;

  async function onSubmit(values: JournalEntryInput) {
    const result = await createJournalEntryAction(values);
    if (!applyResult(result)) return;
    router.push(`/app/accounting/journal/${result.data.id}`);
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        <FormError message={formError} />

        <Card>
          <CardContent className="grid gap-5 py-6 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="voucherType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>What kind of entry</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {MANUAL_VOUCHER_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {MANUAL_VOUCHER_LABELS[type].label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {MANUAL_VOUCHER_LABELS[voucherType].hint}
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="entryDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Date</FormLabel>
                  <FormControl>
                    <Input type="date" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="narration"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel>What is this for?</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={2}
                      placeholder="Depreciation on the display fridge for the year"
                      {...field}
                    />
                  </FormControl>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Required, and worth writing properly. This is what an
                    auditor — or you, next year — will read to work out why the
                    entry exists.
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="referenceNo"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Reference{" "}
                    <span className="font-normal text-muted-foreground">
                      (optional)
                    </span>
                  </FormLabel>
                  <FormControl>
                    <Input placeholder="Board resolution 4/2026" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 py-6">
            <div className="hidden gap-3 px-1 text-xs text-muted-foreground sm:grid sm:grid-cols-[1fr_9rem_9rem_2.25rem]">
              <span>Account</span>
              <span className="text-right">Debit</span>
              <span className="text-right">Credit</span>
              <span />
            </div>

            {fields.map((field, index) => {
              const line = lines[index];
              const account = line?.accountId
                ? (accountsById.get(line.accountId) ?? null)
                : null;
              const parties =
                account?.partyType === "CUSTOMER"
                  ? customers
                  : account?.partyType === "SUPPLIER"
                    ? suppliers
                    : [];

              return (
                <div
                  key={field.id}
                  className="rounded-lg border p-3 sm:border-0 sm:p-0"
                >
                  <div className="grid gap-3 sm:grid-cols-[1fr_9rem_9rem_2.25rem] sm:items-start">
                    <FormField
                      control={form.control}
                      name={`lines.${index}.accountId`}
                      render={() => (
                        <FormItem>
                          <FormLabel className="sm:sr-only">Account</FormLabel>
                          <AccountPicker
                            name={`lines.${index}.accountId`}
                            value={account}
                            accounts={accounts}
                            onSelect={(chosen) => {
                              form.setValue(
                                `lines.${index}.accountId`,
                                chosen.id,
                                { shouldValidate: true },
                              );
                              form.setValue(`lines.${index}.partyId`, "");
                              if (chosen.partyType === "CUSTOMER")
                                void ensureParties("CUSTOMER");
                              if (chosen.partyType === "SUPPLIER")
                                void ensureParties("SUPPLIER");
                            }}
                          />
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name={`lines.${index}.debit`}
                      render={({ field: amount }) => (
                        <FormItem>
                          <FormLabel className="sm:sr-only">Debit</FormLabel>
                          <FormControl>
                            <AmountInput
                              name={amount.name}
                              value={amount.value}
                              onChange={(next) => {
                                amount.onChange(next);
                                // One side or the other. Typing into this one
                                // clears the other rather than producing a line
                                // the schema will reject a moment later.
                                if (next > 0) {
                                  form.setValue(`lines.${index}.credit`, 0);
                                }
                              }}
                              className="text-right"
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name={`lines.${index}.credit`}
                      render={({ field: amount }) => (
                        <FormItem>
                          <FormLabel className="sm:sr-only">Credit</FormLabel>
                          <FormControl>
                            <AmountInput
                              name={amount.name}
                              value={amount.value}
                              onChange={(next) => {
                                amount.onChange(next);
                                if (next > 0) {
                                  form.setValue(`lines.${index}.debit`, 0);
                                }
                              }}
                              className="text-right"
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="justify-self-end"
                      disabled={fields.length <= 2}
                      onClick={() => remove(index)}
                      aria-label={`Remove line ${index + 1}`}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>

                  {account?.partyType && (
                    <div className="mt-3 sm:ml-0 sm:max-w-md">
                      <FormField
                        control={form.control}
                        name={`lines.${index}.partyId`}
                        render={({ field: party }) => (
                          <FormItem>
                            <FormLabel>
                              {account.partyType === "CUSTOMER"
                                ? "Whose debt is this?"
                                : "Whom is this owed to?"}
                            </FormLabel>
                            <Select
                              onValueChange={party.onChange}
                              value={party.value || ""}
                            >
                              <FormControl>
                                <SelectTrigger>
                                  <SelectValue placeholder="Choose a name" />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                {parties.map((entry) => (
                                  <SelectItem key={entry.id} value={entry.id}>
                                    {entry.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
                              <Info className="mt-0.5 size-3 shrink-0" />
                              {account.name} is a control account. A balance
                              here that belongs to nobody can never be chased,
                              aged or settled — it just makes the outstanding
                              report wrong.
                            </p>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                  )}
                </div>
              );
            })}

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => append({ ...EMPTY_JOURNAL_LINE })}
            >
              <Plus className="size-4" />
              Add a line
            </Button>

            {form.formState.errors.lines?.root?.message && (
              <p className="text-sm text-destructive">
                {form.formState.errors.lines.root.message}
              </p>
            )}
          </CardContent>
        </Card>

        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border px-5 py-4">
          <dl className="flex flex-wrap items-baseline gap-6 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Debits</dt>
              <dd className="tabular-figures text-lg font-semibold">
                {formatCurrency(totals.debit)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Credits</dt>
              <dd className="tabular-figures text-lg font-semibold">
                {formatCurrency(totals.credit)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Difference</dt>
              <dd
                className={cn(
                  "tabular-figures text-lg font-semibold",
                  difference === 0
                    ? "text-success-foreground"
                    : "text-destructive",
                )}
              >
                {formatCurrency(Math.abs(difference))}
              </dd>
            </div>
          </dl>

          <div className="flex flex-col items-end gap-1.5">
            <Button
              type="submit"
              disabled={difference !== 0 || !hasValue}
              loading={form.formState.isSubmitting}
              loadingText="Posting…"
            >
              Post entry
            </Button>
            <p className="text-xs text-muted-foreground">
              {!hasValue
                ? "Enter the amounts."
                : difference === 0
                  ? "Balanced. Checked again on the server before it posts."
                  : difference > 0
                    ? `Debits exceed credits by ${formatCurrency(difference)}.`
                    : `Credits exceed debits by ${formatCurrency(Math.abs(difference))}.`}
            </p>
          </div>
        </div>
      </form>
    </Form>
  );
}
