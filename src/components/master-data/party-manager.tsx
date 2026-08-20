"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArchiveRestore, EllipsisVertical, Plus } from "lucide-react";
import { FormError } from "@/components/auth/form-error";
import { useServerFormErrors } from "@/components/auth/use-action-form";
import {
  ListPagination,
  ListToolbar,
} from "@/components/master-data/list-toolbar";
import {
  OpeningBalanceFields,
  announceDeferredOpening,
} from "@/components/master-data/opening-balance-fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { AmountInput } from "@/components/ui/amount-input";
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
import {
  INDIAN_STATES,
  findStateByCode,
  gstinStateCode,
} from "@/lib/constants/india";
import { formatCurrency } from "@/lib/format";
import {
  partyFormSchema,
  type CustomerInput,
  type PartyFormInput,
  type SupplierInput,
} from "@/lib/validation/master-data";
import type { ActionResult } from "@/server/auth/action-result";
import type { PartyKind, PartyRow } from "@/server/master-data/party-service";
import {
  createPartyAction,
  setPartyArchivedAction,
  updatePartyAction,
} from "@/server/master-data/actions";

/**
 * Customer and supplier list.
 *
 * One component for both because they are the same record with the sign
 * flipped. The wording differs — a customer owes you, a supplier is owed — and
 * that difference is data, not a second copy of the component.
 */

type PartyCopy = {
  singular: string;
  plural: string;
  debitLabel: string;
  creditLabel: string;
  postingNote: string;
  emptyTitle: string;
  emptyBody: string;
};

const COPY: Record<PartyKind, PartyCopy> = {
  CUSTOMER: {
    singular: "customer",
    plural: "customers",
    debitLabel: "They owe you",
    creditLabel: "You hold their advance",
    postingNote:
      "Saved as a posted journal entry dated the first day of your financial year — receivables against owner's capital. Change it later and a correction entry is posted for the difference; the original stays in the books.",
    emptyTitle: "No customers yet",
    emptyBody:
      "Add the businesses and people you sell to on credit. Walk-in cash sales do not need a customer record.",
  },
  SUPPLIER: {
    singular: "supplier",
    plural: "suppliers",
    debitLabel: "You paid them in advance",
    creditLabel: "You owe them",
    postingNote:
      "Saved as a posted journal entry dated the first day of your financial year — payables against owner's capital. Change it later and a correction entry is posted for the difference; the original stays in the books.",
    emptyTitle: "No suppliers yet",
    emptyBody:
      "Add the wholesalers and distributors you buy from, so purchase bills can be matched to what you owe each of them.",
  },
};

function emptyValues(kind: PartyKind): PartyFormInput {
  return {
    name: "",
    phone: "",
    email: "",
    gstin: "",
    pan: "",
    addressLine1: "",
    city: "",
    stateCode: "",
    pincode: "",
    creditDays: 0,
    creditLimit: 0,
    openingBalance: 0,
    openingNature: kind === "CUSTOMER" ? "DEBIT" : "CREDIT",
    notes: "",
  };
}

export function PartyManager({
  kind,
  result,
  canManage,
}: {
  kind: PartyKind;
  result: { rows: PartyRow[]; total: number; page: number; pageCount: number };
  canManage: boolean;
}) {
  const router = useRouter();
  const copy = COPY[kind];
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<string | null>(null);
  const [dialog, setDialog] = React.useState<
    { mode: "create" } | { mode: "edit"; party: PartyRow } | null
  >(null);

  async function run(
    id: string,
    operation: () => Promise<ActionResult<unknown>>,
  ) {
    setError(null);
    setPending(id);
    try {
      const outcome = await operation();
      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ListToolbar
          searchPlaceholder={`Search ${copy.plural}`}
          archivedLabel="Show archived"
        />
        {canManage && (
          <Button onClick={() => setDialog({ mode: "create" })}>
            <Plus className="size-4" />
            Add {copy.singular}
          </Button>
        )}
      </div>

      <FormError message={error} />

      {result.rows.length === 0 ? (
        <div className="rounded-xl border border-dashed px-6 py-14 text-center">
          <h2 className="text-base font-semibold">{copy.emptyTitle}</h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
            {copy.emptyBody}
          </p>
          {canManage && (
            <Button
              className="mt-5"
              onClick={() => setDialog({ mode: "create" })}
            >
              <Plus className="size-4" />
              Add {copy.singular}
            </Button>
          )}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Contact</TableHead>
              <TableHead>GSTIN</TableHead>
              <TableHead className="text-right">Opening balance</TableHead>
              <TableHead className="text-right">Credit</TableHead>
              {canManage && <TableHead className="w-12" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.rows.map((party) => (
              <TableRow
                key={party.id}
                data-state={party.isArchived ? "archived" : undefined}
              >
                <TableCell>
                  <p className="flex flex-wrap items-center gap-1.5 font-medium">
                    {party.name}
                    {party.isArchived && (
                      <Badge variant="muted">Archived</Badge>
                    )}
                  </p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {party.code}
                    {party.city ? ` · ${party.city}` : ""}
                  </p>
                </TableCell>
                <TableCell className="text-sm">
                  {party.phone ?? party.email ?? (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {party.gstin ?? (
                    <span className="font-sans text-muted-foreground">
                      Unregistered
                    </span>
                  )}
                </TableCell>
                <TableCell className="tabular-figures text-right">
                  {Number(party.openingBalance) === 0 ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <>
                      {formatCurrency(party.openingBalance)}
                      <span className="ml-1 text-xs text-muted-foreground">
                        {party.openingNature === "DEBIT" ? "Dr" : "Cr"}
                      </span>
                    </>
                  )}
                </TableCell>
                <TableCell className="tabular-figures text-right text-sm">
                  {party.creditLimit && Number(party.creditLimit) > 0
                    ? formatCurrency(party.creditLimit, {
                        compactZeroDecimals: true,
                      })
                    : null}
                  {party.creditDays > 0 && (
                    <span className="block text-xs text-muted-foreground">
                      {party.creditDays} days
                    </span>
                  )}
                  {(!party.creditLimit || Number(party.creditLimit) === 0) &&
                    party.creditDays === 0 && (
                      <span className="text-muted-foreground">—</span>
                    )}
                </TableCell>
                {canManage && (
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Manage ${party.name}`}
                          loading={pending === party.id}
                        >
                          <EllipsisVertical className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => setDialog({ mode: "edit", party })}
                        >
                          Edit details
                        </DropdownMenuItem>
                        {party.isArchived ? (
                          <DropdownMenuItem
                            onClick={() =>
                              run(party.id, () =>
                                setPartyArchivedAction(kind, party.id, false),
                              )
                            }
                          >
                            <ArchiveRestore className="size-4" />
                            Restore
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() =>
                              run(party.id, () =>
                                setPartyArchivedAction(kind, party.id, true),
                              )
                            }
                          >
                            Archive
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <ListPagination
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
        noun={copy.singular}
      />

      <p className="text-xs leading-relaxed text-muted-foreground">
        Records are archived, never deleted. A {copy.singular} with an opening
        balance is already named in a posted journal entry, and an entry that
        cannot say who it was with is not an audit trail.
      </p>

      <PartyDialog
        kind={kind}
        state={dialog}
        onClose={() => setDialog(null)}
        onSaved={() => {
          setDialog(null);
          router.refresh();
        }}
      />
    </div>
  );
}

function PartyDialog({
  kind,
  state,
  onClose,
  onSaved,
}: {
  kind: PartyKind;
  state: { mode: "create" } | { mode: "edit"; party: PartyRow } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const copy = COPY[kind];
  const editing = state?.mode === "edit" ? state.party : null;

  const form = useForm<PartyFormInput>({
    resolver: zodResolver(partyFormSchema),
    defaultValues: emptyValues(kind),
  });

  const { formError, applyResult, reset } = useServerFormErrors(form);

  const key = editing?.id ?? state?.mode ?? null;
  const [lastKey, setLastKey] = React.useState<string | null>(null);
  if (key !== lastKey) {
    setLastKey(key);
    form.reset(
      editing
        ? {
            ...emptyValues(kind),
            name: editing.name,
            phone: editing.phone ?? "",
            email: editing.email ?? "",
            gstin: editing.gstin ?? "",
            city: editing.city ?? "",
            stateCode: editing.stateCode ?? "",
            creditDays: editing.creditDays,
            creditLimit: Number(editing.creditLimit ?? 0),
            openingBalance: Number(editing.openingBalance),
            openingNature: editing.openingNature,
          }
        : emptyValues(kind),
    );
    reset();
  }

  const gstin = form.watch("gstin");
  // A GSTIN states the party's registered state, so filling it in from there
  // is more reliable than asking someone to pick the matching entry twice.
  const gstinState = gstin ? gstinStateCode(gstin) : null;
  const derivedState = gstinState ? findStateByCode(gstinState) : null;

  async function onSubmit(values: PartyFormInput) {
    const payload: CustomerInput | SupplierInput =
      kind === "CUSTOMER" ? values : stripCreditLimit(values);
    // The two branches are kept apart rather than merged into one `result`,
    // because only creating a party carries an opening balance — and so only
    // that result can report the balance having been dated forward.
    if (editing) {
      const result = await updatePartyAction(kind, editing.id, payload);
      if (!applyResult(result as ActionResult<unknown>)) return;
    } else {
      const result = await createPartyAction(kind, payload);
      if (!applyResult(result as ActionResult<unknown>)) return;
      if (result.ok) {
        announceDeferredOpening(result.data.openingDeferredTo, values.name);
      }
    }
    onSaved();
  }

  return (
    <Dialog open={Boolean(state)} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {editing ? `Edit ${copy.singular}` : `Add a ${copy.singular}`}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? `${editing.code} — changes apply to future documents. Anything already posted keeps the details it was raised with.`
              : `A code is assigned automatically. Only the name is required; the rest can wait until you need it.`}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
            <FormError message={formError} />

            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input autoFocus {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-5 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="phone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Mobile
                      <span className="font-normal text-muted-foreground">
                        (optional)
                      </span>
                    </FormLabel>
                    <FormControl>
                      <Input inputMode="tel" maxLength={13} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Email
                      <span className="font-normal text-muted-foreground">
                        (optional)
                      </span>
                    </FormLabel>
                    <FormControl>
                      <Input type="email" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="gstin"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      GSTIN
                      <span className="font-normal text-muted-foreground">
                        (optional)
                      </span>
                    </FormLabel>
                    <FormControl>
                      <Input
                        maxLength={15}
                        className="font-mono uppercase"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      {derivedState
                        ? `Registered in ${derivedState.name} — this decides whether GST splits as CGST + SGST or is charged as IGST.`
                        : "Leave blank for an unregistered party."}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="pan"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      PAN
                      <span className="font-normal text-muted-foreground">
                        (optional)
                      </span>
                    </FormLabel>
                    <FormControl>
                      <Input
                        maxLength={10}
                        className="font-mono uppercase"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="addressLine1"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Address
                    <span className="font-normal text-muted-foreground">
                      (optional)
                    </span>
                  </FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-5 sm:grid-cols-3">
              <FormField
                control={form.control}
                name="city"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>City</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="stateCode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>State</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent className="max-h-72">
                        {INDIAN_STATES.map((state) => (
                          <SelectItem key={state.code} value={state.code}>
                            {state.name}
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
                name="pincode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>PIN code</FormLabel>
                    <FormControl>
                      <Input inputMode="numeric" maxLength={6} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="creditDays"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Credit days</FormLabel>
                    <FormControl>
                      <AmountInput
                        name={field.name}
                        value={field.value}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        min={0}
                        max={365}
                        step="1"
                      />
                    </FormControl>
                    <FormDescription>
                      0 means payment is due immediately.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {kind === "CUSTOMER" && (
                <FormField
                  control={form.control}
                  name="creditLimit"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Credit limit</FormLabel>
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
                      <FormDescription>
                        0 means no limit is enforced.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
            </div>

            <OpeningBalanceFields
              control={form.control}
              amountName="openingBalance"
              natureName="openingNature"
              debitLabel={copy.debitLabel}
              creditLabel={copy.creditLabel}
              postingNote={copy.postingNote}
            />

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

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                loading={form.formState.isSubmitting}
                loadingText="Saving…"
              >
                {editing ? "Save changes" : `Add ${copy.singular}`}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

/** A supplier has no credit limit, so it never reaches the server. */
function stripCreditLimit(values: PartyFormInput): SupplierInput {
  const { creditLimit: _ignored, ...rest } = values;
  return rest;
}
