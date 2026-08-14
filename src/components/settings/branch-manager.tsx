"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { EllipsisVertical, MapPin, Plus, Star } from "lucide-react";
import { FormError } from "@/components/auth/form-error";
import { useServerFormErrors } from "@/components/auth/use-action-form";
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
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { INDIAN_STATES } from "@/lib/constants/india";
import { branchSchema, type BranchInput } from "@/lib/validation/company";
import type { ActionResult } from "@/server/auth/action-result";
import {
  createBranchAction,
  setBranchActiveAction,
  setPrimaryBranchAction,
  updateBranchAction,
} from "@/server/company/actions";

export type BranchRow = {
  id: string;
  code: string;
  name: string;
  city: string | null;
  isPrimary: boolean;
  isActive: boolean;
  activityCount: number;
  memberCount: number;
};

export function BranchManager({
  branches,
  canManage,
}: {
  branches: BranchRow[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<string | null>(null);
  const [dialog, setDialog] = React.useState<
    { mode: "create" } | { mode: "edit"; branch: BranchRow } | null
  >(null);

  // Deliberately loose in its return type: the callers below invoke actions
  // with different success payloads, and this helper only cares whether the
  // call succeeded.
  async function run(
    id: string,
    operation: () => Promise<{ ok: boolean; message?: string }>,
  ) {
    setError(null);
    setPending(id);
    try {
      const result = await operation();
      if (!result.ok) {
        setError(result.message ?? "That change could not be applied.");
        return;
      }
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Branches</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Each location that records transactions. The primary branch is where
            anything without an explicit location posts.
          </p>
        </div>
        {canManage && (
          <Button onClick={() => setDialog({ mode: "create" })}>
            <Plus className="size-4" />
            Add branch
          </Button>
        )}
      </div>

      <FormError message={error} />

      <ul className="divide-y overflow-hidden rounded-xl border">
        {branches.map((branch) => (
          <li
            key={branch.id}
            className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5"
          >
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
                <MapPin className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                  {branch.name}
                  <Badge
                    variant="outline"
                    className="font-mono text-[0.6875rem]"
                  >
                    {branch.code}
                  </Badge>
                  {branch.isPrimary && (
                    <Badge variant="default">
                      <Star className="size-3" />
                      Primary
                    </Badge>
                  )}
                  {!branch.isActive && <Badge variant="muted">Closed</Badge>}
                </p>
                <p className="text-xs text-muted-foreground">
                  {branch.city ?? "No city set"}
                  {branch.activityCount > 0 &&
                    ` · ${branch.activityCount} recorded ${
                      branch.activityCount === 1 ? "document" : "documents"
                    }`}
                  {branch.memberCount > 0 &&
                    ` · ${branch.memberCount} assigned ${
                      branch.memberCount === 1 ? "member" : "members"
                    }`}
                </p>
              </div>
            </div>

            {canManage && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Manage ${branch.name}`}
                    loading={pending === branch.id}
                  >
                    <EllipsisVertical className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() => setDialog({ mode: "edit", branch })}
                  >
                    Edit details
                  </DropdownMenuItem>
                  {!branch.isPrimary && branch.isActive && (
                    <DropdownMenuItem
                      onClick={() =>
                        run(branch.id, () => setPrimaryBranchAction(branch.id))
                      }
                    >
                      <Star className="size-4" />
                      Make primary
                    </DropdownMenuItem>
                  )}
                  {branch.isActive ? (
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={branch.isPrimary}
                      onClick={() =>
                        run(branch.id, () =>
                          setBranchActiveAction(branch.id, false),
                        )
                      }
                    >
                      Close branch
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem
                      onClick={() =>
                        run(branch.id, () =>
                          setBranchActiveAction(branch.id, true),
                        )
                      }
                    >
                      Reopen branch
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </li>
        ))}
      </ul>

      {/* Explains why there is no delete option, rather than leaving people
          hunting for one. */}
      <p className="text-xs leading-relaxed text-muted-foreground">
        A branch that has recorded transactions can be closed but not deleted —
        removing it would leave those entries unable to say where they happened.
      </p>

      <BranchDialog
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

function BranchDialog({
  state,
  onClose,
  onSaved,
}: {
  state: { mode: "create" } | { mode: "edit"; branch: BranchRow } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = state?.mode === "edit" ? state.branch : null;

  const form = useForm<BranchInput>({
    resolver: zodResolver(branchSchema),
    defaultValues: {
      code: "",
      name: "",
      addressLine1: "",
      city: "",
      stateCode: "",
      pincode: "",
      phone: "",
    },
  });

  const { formError, applyResult, reset } = useServerFormErrors(form);

  // Re-seed the form whenever a different branch is opened.
  const key = editing?.id ?? state?.mode ?? null;
  const [lastKey, setLastKey] = React.useState<string | null>(null);
  if (key !== lastKey) {
    setLastKey(key);
    form.reset({
      code: editing?.code ?? "",
      name: editing?.name ?? "",
      addressLine1: "",
      city: editing?.city ?? "",
      stateCode: "",
      pincode: "",
      phone: "",
    });
    reset();
  }

  async function onSubmit(values: BranchInput) {
    // Create returns the new id and update returns a saved flag. Neither is
    // used here, so the result is widened rather than branching on the shape.
    const result: ActionResult<unknown> = editing
      ? await updateBranchAction(editing.id, values)
      : await createBranchAction(values);
    if (!applyResult(result)) return;
    onSaved();
  }

  return (
    <Dialog open={Boolean(state)} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? "Edit branch" : "Add a branch"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Update where this location is and how to reach it."
              : "A second shop, warehouse or counter that records its own transactions."}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
            <FormError message={formError} />

            <div className="grid gap-5 sm:grid-cols-[8rem_1fr]">
              <FormField
                control={form.control}
                name="code"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Code</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="BLR2"
                        maxLength={12}
                        className="uppercase"
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
                    <FormLabel>Branch name</FormLabel>
                    <FormControl>
                      <Input placeholder="Jayanagar Shop" {...field} />
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

            <div className="grid gap-5 sm:grid-cols-2">
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

            <FormField
              control={form.control}
              name="stateCode"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>State</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Same as head office" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent className="max-h-72">
                      {INDIAN_STATES.map((indianState) => (
                        <SelectItem
                          key={indianState.code}
                          value={indianState.code}
                        >
                          {indianState.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    A branch in another state changes how its supplies are
                    taxed.
                  </FormDescription>
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
                {editing ? "Save changes" : "Add branch"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
