"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Info, Loader2, TriangleAlert, Wand2 } from "lucide-react";
import { FormError } from "@/components/auth/form-error";
import { useServerFormErrors } from "@/components/auth/use-action-form";
import { AmountInput } from "@/components/ui/amount-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormDescription,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { formatCurrency, formatDate } from "@/lib/format";
import { add, money, subtract } from "@/lib/money";
import { allocateOldestFirst } from "@/lib/settlements/ageing";
import {
  SETTLEMENT_MODES,
  SETTLEMENT_MODE_LABELS,
} from "@/lib/validation/settlements";
import type { ActionResult } from "@/server/auth/action-result";
import type { OpenDocument } from "@/server/settlements/outstanding";

/**
 * Recording money in or money out.
 *
 * One component for both, because a receipt and a payment are the same event
 * with the arrow reversed. What differs — who the party is, what the sources
 * are called, which action posts it — arrives as configuration.
 *
 * The allocation table is the part that earns its place. Money received against
 * no particular invoice still reduces what the customer owes, but nobody can
 * then say *which* bill was paid, and the ageing report goes vague. So the open
 * documents are listed with what each still owes, and "settle oldest first" —
 * which is what an accountant would do by hand — is one click.
 */

export type PartyOption = { id: string; name: string };

export type SettlementKindOption = {
  value: string;
  label: string;
  hint: string;
  /** Only the party kind can be allocated against documents. */
  allocatable: boolean;
};

/**
 * What the fields hold while someone is filling the form in. Every one of them
 * is present because the defaults set them, which is what lets the inputs stay
 * controlled from the first keystroke.
 */
type FormValues = {
  kind: string;
  partyId: string;
  date: string;
  paymentMode: string;
  amount: number;
  referenceNo: string;
  notes: string;
  allocations: Array<{ documentId: string; amount: number }>;
};

/**
 * What a caller's schema has to produce. Looser than `FormValues` because a
 * schema is entitled to make an optional field optional — a receipt that is not
 * a customer collection has no party at all.
 */
type SettlementValues = {
  kind: string;
  partyId?: string | undefined;
  date: string;
  paymentMode: string;
  amount: number;
  referenceNo?: string | undefined;
  notes?: string | undefined;
  allocations: Array<{ documentId: string; amount: number }>;
};

export function SettlementForm<TInput extends SettlementValues>({
  schema,
  kinds,
  parties,
  copy,
  loadOpenDocuments,
  submit,
  redirectTo,
  today,
}: {
  schema: Parameters<typeof zodResolver>[0];
  kinds: SettlementKindOption[];
  parties: PartyOption[];
  copy: {
    partyLabel: string;
    partyPlaceholder: string;
    kindLabel: string;
    amountLabel: string;
    submitLabel: string;
    documentNoun: string;
    /** "an" for an invoice, "a" for a bill. Prose, not a template. */
    documentArticle: string;
    /** What unmatched money means for this direction. */
    unallocatedNote: string;
    emptyOpenNote: string;
  };
  loadOpenDocuments: (partyId: string) => Promise<OpenDocument[]>;
  submit: (values: TInput) => Promise<ActionResult<{ id: string }>>;
  redirectTo: (id: string) => string;
  /** The shop's own calendar day, worked out from its time zone. */
  today: string;
}) {
  const router = useRouter();

  const form = useForm<FormValues>({
    // The caller owns the schema; the shape it validates is this one.
    resolver: zodResolver(schema) as never,
    defaultValues: {
      kind: kinds[0]?.value ?? "",
      partyId: "",
      date: today,
      paymentMode: "CASH",
      amount: 0,
      referenceNo: "",
      notes: "",
      allocations: [],
    },
  });

  const { formError, applyResult } = useServerFormErrors(form);
  const watched = form.watch();

  const [open, setOpen] = React.useState<OpenDocument[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [amounts, setAmounts] = React.useState<Record<string, number>>({});
  const requestId = React.useRef(0);

  const kind = kinds.find((entry) => entry.value === watched.kind);
  const allocatable = kind?.allocatable ?? false;

  async function onPartyChange(partyId: string) {
    form.setValue("partyId", partyId);
    setAmounts({});
    if (!partyId || !allocatable) {
      setOpen([]);
      return;
    }
    setLoading(true);
    const id = ++requestId.current;
    try {
      const documents = await loadOpenDocuments(partyId);
      if (id !== requestId.current) return;
      setOpen(documents);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }

  const allocated = add(...Object.values(amounts).map((value) => value || 0));
  const unallocated = subtract(watched.amount || 0, allocated);
  const overAllocated = allocated.greaterThan(watched.amount || 0);

  function settleOldestFirst() {
    const { allocations } = allocateOldestFirst(
      watched.amount || 0,
      open.map((document) => ({
        id: document.id,
        outstanding: document.outstanding,
        dueDate: new Date(`${document.dueDate}T00:00:00.000Z`),
      })),
    );
    const next: Record<string, number> = {};
    for (const allocation of allocations) {
      next[allocation.id] = Number(allocation.amount.toFixed(2));
    }
    setAmounts(next);
  }

  async function onSubmit(values: FormValues) {
    const payload = {
      ...values,
      allocations: Object.entries(amounts)
        .filter(([, amount]) => amount > 0)
        .map(([documentId, amount]) => ({ documentId, amount })),
    } as TInput;

    const result = await submit(payload);
    if (!applyResult(result)) return;
    router.push(redirectTo(result.data.id));
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        <FormError message={formError} />

        <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
          <div className="space-y-6">
            <Card>
              <CardContent className="grid gap-5 py-6 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="kind"
                  render={({ field }) => (
                    <FormItem className="sm:col-span-2">
                      <FormLabel>{copy.kindLabel}</FormLabel>
                      <Select
                        onValueChange={(value) => {
                          field.onChange(value);
                          const next = kinds.find(
                            (entry) => entry.value === value,
                          );
                          if (!next?.allocatable) {
                            setOpen([]);
                            setAmounts({});
                          }
                        }}
                        value={field.value}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {kinds.map((entry) => (
                            <SelectItem key={entry.value} value={entry.value}>
                              {entry.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {kind && <FormDescription>{kind.hint}</FormDescription>}
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {allocatable && (
                  <FormField
                    control={form.control}
                    name="partyId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{copy.partyLabel}</FormLabel>
                        <Select
                          onValueChange={onPartyChange}
                          value={field.value}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue
                                placeholder={copy.partyPlaceholder}
                              />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent className="max-h-72">
                            {parties.map((party) => (
                              <SelectItem key={party.id} value={party.id}>
                                {party.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}

                <FormField
                  control={form.control}
                  name="date"
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
                  name="amount"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{copy.amountLabel}</FormLabel>
                      <FormControl>
                        <AmountInput
                          prefix="₹"
                          name={field.name}
                          value={field.value}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                          min={0}
                          step="0.01"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="paymentMode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>How</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {SETTLEMENT_MODES.map((mode) => (
                            <SelectItem key={mode} value={mode}>
                              {SETTLEMENT_MODE_LABELS[mode]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
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
                        Reference
                        <span className="font-normal text-muted-foreground">
                          (optional)
                        </span>
                      </FormLabel>
                      <FormControl>
                        <Input
                          placeholder="UPI reference, cheque number"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>

            {allocatable && watched.partyId && (
              <Card>
                <CardContent className="py-5">
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-semibold">
                        Which {copy.documentNoun}s does this settle?
                      </h2>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {copy.unallocatedNote}
                      </p>
                    </div>
                    {open.length > 0 && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={settleOldestFirst}
                        disabled={!watched.amount}
                      >
                        <Wand2 className="size-3.5" />
                        Settle oldest first
                      </Button>
                    )}
                  </div>

                  {loading ? (
                    <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                      <Loader2 className="size-4 animate-spin" />
                      Looking up what is outstanding…
                    </p>
                  ) : open.length === 0 ? (
                    <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                      {copy.emptyOpenNote}
                    </p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{copy.documentNoun}</TableHead>
                          <TableHead>Due</TableHead>
                          <TableHead className="text-right">
                            Outstanding
                          </TableHead>
                          <TableHead className="w-36 text-right">
                            Settling
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {open.map((document) => (
                          <TableRow key={document.id}>
                            <TableCell className="font-medium">
                              {document.number}
                              <span className="block text-xs text-muted-foreground">
                                {formatDate(document.date, { style: "short" })}
                              </span>
                            </TableCell>
                            <TableCell className="text-sm">
                              {formatDate(document.dueDate, { style: "short" })}
                              {document.daysOverdue > 0 && (
                                <Badge
                                  variant={
                                    document.daysOverdue > 60
                                      ? "danger"
                                      : "warning"
                                  }
                                  className="ml-1.5 text-[0.625rem]"
                                >
                                  {document.daysOverdue}d
                                </Badge>
                              )}
                            </TableCell>
                            <TableCell className="tabular-figures text-right">
                              {formatCurrency(document.outstanding)}
                            </TableCell>
                            <TableCell>
                              <AmountInput
                                aria-label={`Amount against ${document.number}`}
                                value={amounts[document.id] ?? 0}
                                onChange={(value) =>
                                  setAmounts((current) => ({
                                    ...current,
                                    [document.id]: value,
                                  }))
                                }
                                min={0}
                                max={Number(document.outstanding)}
                                step="0.01"
                                className="text-right"
                              />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            )}

            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Notes
                    <span className="font-normal text-muted-foreground">
                      (optional)
                    </span>
                  </FormLabel>
                  <FormControl>
                    <Textarea rows={2} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <Card className="h-fit">
            <CardContent className="space-y-2 py-5 text-sm">
              <div className="flex items-baseline justify-between">
                <span className="font-medium">{copy.amountLabel}</span>
                <span className="tabular-figures text-lg font-semibold">
                  {formatCurrency(money(watched.amount || 0).toFixed(4))}
                </span>
              </div>

              {allocatable && (
                <>
                  <div className="flex items-baseline justify-between border-t pt-3">
                    <span className="text-muted-foreground">Matched</span>
                    <span className="tabular-figures">
                      {formatCurrency(allocated.toFixed(4))}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between">
                    <span className="text-muted-foreground">
                      {unallocated.isNegative() ? "Over-matched" : "On account"}
                    </span>
                    <span className="tabular-figures">
                      {formatCurrency(unallocated.abs().toFixed(4))}
                    </span>
                  </div>
                </>
              )}

              {overAllocated && (
                <p className="flex items-start gap-1.5 pt-2 text-xs leading-relaxed text-destructive">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                  More has been matched than was{" "}
                  {copy.amountLabel.toLowerCase()}.
                </p>
              )}

              {allocatable && !overAllocated && unallocated.greaterThan(0) && (
                <p className="flex items-start gap-1.5 pt-2 text-xs leading-relaxed text-muted-foreground">
                  <Info className="mt-0.5 size-3.5 shrink-0" />
                  {formatCurrency(unallocated.toFixed(4))} is not matched to{" "}
                  {copy.documentArticle} {copy.documentNoun}. It still reduces
                  the balance — it just sits on account until it is matched.
                </p>
              )}

              <Button
                type="submit"
                className="mt-2 w-full"
                loading={form.formState.isSubmitting}
                loadingText="Recording…"
                disabled={overAllocated}
              >
                {copy.submitLabel}
              </Button>
            </CardContent>
          </Card>
        </div>
      </form>
    </Form>
  );
}
