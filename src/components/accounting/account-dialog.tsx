"use client";

import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Lock } from "lucide-react";
import { FormError } from "@/components/auth/form-error";
import { useServerFormErrors } from "@/components/auth/use-action-form";
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
import {
  ACCOUNT_TYPE_HINTS,
  ACCOUNT_TYPE_LABELS,
} from "@/lib/accounting/account-tree";
import {
  ACCOUNT_TYPES,
  accountEditSchema,
  accountSchema,
  DEFAULT_GROUP_CODE,
  SELECTABLE_SUBTYPES,
  type AccountEditInput,
  type AccountInput,
  type AccountTypeInput,
} from "@/lib/validation/accounts";
import type {
  ChartAccount,
  ChartGroup,
} from "@/server/accounting/account-service";
import {
  createAccountAction,
  updateAccountAction,
} from "@/server/accounting/actions";

/**
 * Adding an account, or renaming one.
 *
 * These are two different operations wearing one dialog, because they are the
 * same thing to the person doing them. Creating asks where the account belongs;
 * editing does not offer to move it, because renumbering or reclassifying an
 * account that has been posted to would change how last year's books print. A
 * name, on the other hand, is only a label — call Sales "Counter Takings" if
 * that is the word used in the shop, and every posting rule carries on working
 * because they resolve accounts by a key nobody can edit.
 */
export function AccountDialog({
  open,
  account,
  groups,
  onClose,
}: {
  open: boolean;
  /** Present when editing, absent when adding. */
  account: ChartAccount | null;
  /** Every group in the chart. Filtered here by the type being added. */
  groups: ChartGroup[];
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        {account ? (
          <EditAccount account={account} onClose={onClose} />
        ) : (
          <NewAccount groups={groups} onClose={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The group list arrives with the page rather than being fetched when a type is
 * chosen. It is the same handful of rows for every type and it is not secret,
 * so a round trip would only buy a moment where the field is empty and a submit
 * fails for a reason nobody typed.
 */
function groupsForType(groups: ChartGroup[], type: AccountTypeInput) {
  return groups
    .filter((group) => group.type === type)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

function defaultGroupId(groups: ChartGroup[], subType: string): string {
  const preferred = DEFAULT_GROUP_CODE[subType];
  return (
    groups.find((group) => group.code === preferred)?.id ?? groups[0]?.id ?? ""
  );
}

function NewAccount({
  groups: allGroups,
  onClose,
}: {
  groups: ChartGroup[];
  onClose: () => void;
}) {
  const router = useRouter();

  const form = useForm<AccountInput>({
    resolver: zodResolver(accountSchema),
    defaultValues: {
      code: "",
      name: "",
      groupId: defaultGroupId(
        groupsForType(allGroups, "EXPENSE"),
        "INDIRECT_EXPENSE",
      ),
      type: "EXPENSE",
      subType: "INDIRECT_EXPENSE",
      description: "",
    },
  });

  const { formError, applyResult } = useServerFormErrors(form);
  const type = form.watch("type");
  const subType = form.watch("subType");
  const groups = groupsForType(allGroups, type);

  function onTypeChange(next: string) {
    const value = next as AccountTypeInput;
    const firstSubType = SELECTABLE_SUBTYPES[value][0]?.value ?? "";
    form.setValue("type", value);
    form.setValue("subType", firstSubType);
    form.setValue(
      "groupId",
      defaultGroupId(groupsForType(allGroups, value), firstSubType),
    );
  }

  function onSubTypeChange(next: string) {
    form.setValue("subType", next);
    form.setValue("groupId", defaultGroupId(groups, next));
  }

  async function onSubmit(values: AccountInput) {
    const result = await createAccountAction(values);
    if (!applyResult(result)) return;
    onClose();
    form.reset();
    router.refresh();
  }

  const subTypes = SELECTABLE_SUBTYPES[type];
  const subTypeHint = subTypes.find((option) => option.value === subType)?.hint;

  return (
    <>
      <DialogHeader>
        <DialogTitle>New account</DialogTitle>
        <DialogDescription>
          A line of your own for something the standard chart does not name — a
          mandi fee, cold storage, a franchise royalty. A cost buried in
          Miscellaneous is a cost nobody manages.
        </DialogDescription>
      </DialogHeader>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
          <FormError message={formError} />

          <FormField
            control={form.control}
            name="type"
            render={({ field }) => (
              <FormItem>
                <FormLabel>What kind of thing is it?</FormLabel>
                <Select onValueChange={onTypeChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {ACCOUNT_TYPES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {ACCOUNT_TYPE_LABELS[value]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {ACCOUNT_TYPE_HINTS[field.value]}
                </p>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="subType"
            render={({ field }) => (
              <FormItem>
                <FormLabel>More precisely</FormLabel>
                <Select onValueChange={onSubTypeChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {subTypes.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {subTypeHint && (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {subTypeHint}
                  </p>
                )}
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="groupId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Filed under</FormLabel>
                <Select
                  onValueChange={field.onChange}
                  value={field.value}
                  disabled={groups.length === 0}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Choose a group" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {groups.map((group) => (
                      <SelectItem key={group.id} value={group.id}>
                        {group.code} · {group.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
            <FormField
              control={form.control}
              name="code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Code</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="6113"
                      className="font-mono"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="Cold storage hire" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name="description"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  What goes in it
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
              loadingText="Adding…"
            >
              Add account
            </Button>
          </DialogFooter>
        </form>
      </Form>
    </>
  );
}

function EditAccount({
  account,
  onClose,
}: {
  account: ChartAccount;
  onClose: () => void;
}) {
  const router = useRouter();

  const form = useForm<AccountEditInput>({
    resolver: zodResolver(accountEditSchema),
    defaultValues: {
      name: account.name,
      description: account.description ?? "",
    },
  });

  const { formError, applyResult } = useServerFormErrors(form);

  async function onSubmit(values: AccountEditInput) {
    const result = await updateAccountAction(account.id, values);
    if (!applyResult(result)) return;
    onClose();
    router.refresh();
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="font-mono">{account.code}</DialogTitle>
        <DialogDescription>
          {account.isSystem
            ? "The system posts to this account automatically. You can call it whatever you like — the rules find it by an identifier no one can edit — but it cannot be moved or put away."
            : "Renaming is safe. The code and where it is filed are fixed, because changing either would alter how entries already posted to it appear in past reports."}
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

          <FormField
            control={form.control}
            name="description"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  What goes in it
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

          {account.isSystem && (
            <p className="flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
              <Lock className="mt-0.5 size-3.5 shrink-0" />
              Posting rules resolve this account by{" "}
              <span className="font-mono">{account.systemKey}</span>, not by its
              name or code, so renaming it changes nothing about how it is used.
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={form.formState.isSubmitting}
              loadingText="Saving…"
            >
              Save
            </Button>
          </DialogFooter>
        </form>
      </Form>
    </>
  );
}
