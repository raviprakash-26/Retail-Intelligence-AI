"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { EllipsisVertical, Plus } from "lucide-react";
import { FormError } from "@/components/auth/form-error";
import { useServerFormErrors } from "@/components/auth/use-action-form";
import {
  ListPagination,
  ListToolbar,
} from "@/components/master-data/list-toolbar";
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
import { formatCurrency, formatDate } from "@/lib/format";
import { employeeSchema, type EmployeeInput } from "@/lib/validation/master-data";
import type { ActionResult } from "@/server/auth/action-result";
import type {
  EmployeeListResult,
  EmployeeRow,
} from "@/server/master-data/employee-service";
import {
  createEmployeeAction,
  updateEmployeeAction,
} from "@/server/master-data/actions";

/**
 * Staff records.
 *
 * Nothing here posts to the ledger. Salary becomes an expense when a payroll
 * run is posted for a period, not when somebody is hired — so these are the
 * terms of employment, and the badge on each row says whether payroll should be
 * counting them.
 */

const STATUS_LABEL: Record<EmployeeRow["status"], string> = {
  ACTIVE: "Active",
  ON_LEAVE: "On leave",
  RESIGNED: "Resigned",
  TERMINATED: "Terminated",
};

const STATUS_VARIANT: Record<EmployeeRow["status"], "success" | "warning" | "muted"> =
  {
    ACTIVE: "success",
    ON_LEAVE: "warning",
    RESIGNED: "muted",
    TERMINATED: "muted",
  };

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyValues(): EmployeeInput {
  return {
    name: "",
    email: "",
    phone: "",
    department: "",
    designation: "",
    joiningDate: today(),
    exitDate: "",
    status: "ACTIVE",
    basicSalary: 0,
    allowances: 0,
    panNumber: "",
    bankAccountNo: "",
    ifsc: "",
  };
}

export function EmployeeManager({
  result,
  canManage,
}: {
  result: EmployeeListResult;
  canManage: boolean;
}) {
  const router = useRouter();
  const [dialog, setDialog] = React.useState<
    { mode: "create" } | { mode: "edit"; employee: EmployeeRow } | null
  >(null);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ListToolbar
          searchPlaceholder="Search by name or role"
          archivedLabel="Include former staff"
        />
        {canManage && (
          <Button onClick={() => setDialog({ mode: "create" })}>
            <Plus className="size-4" />
            Add employee
          </Button>
        )}
      </div>

      {result.rows.length === 0 ? (
        <div className="rounded-xl border border-dashed px-6 py-14 text-center">
          <h2 className="text-base font-semibold">No staff recorded</h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
            Add the people you employ. Their salary terms are held here and used
            when a payroll run is posted — adding someone does not by itself put
            anything in the books.
          </p>
          {canManage && (
            <Button className="mt-5" onClick={() => setDialog({ mode: "create" })}>
              <Plus className="size-4" />
              Add employee
            </Button>
          )}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead className="text-right">Monthly gross</TableHead>
              <TableHead>Status</TableHead>
              {canManage && <TableHead className="w-12" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.rows.map((employee) => (
              <TableRow key={employee.id}>
                <TableCell>
                  <p className="font-medium">{employee.name}</p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {employee.employeeCode}
                    {employee.phone ? ` · ${employee.phone}` : ""}
                  </p>
                </TableCell>
                <TableCell className="text-sm">
                  {employee.designation ?? (
                    <span className="text-muted-foreground">—</span>
                  )}
                  {employee.department && (
                    <span className="block text-xs text-muted-foreground">
                      {employee.department}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-sm whitespace-nowrap">
                  {formatDate(employee.joiningDate, { style: "short" })}
                </TableCell>
                <TableCell className="text-right tabular-figures">
                  {formatCurrency(employee.grossSalary, {
                    compactZeroDecimals: true,
                  })}
                </TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[employee.status]}>
                    {STATUS_LABEL[employee.status]}
                  </Badge>
                </TableCell>
                {canManage && (
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Manage ${employee.name}`}
                        >
                          <EllipsisVertical className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => setDialog({ mode: "edit", employee })}
                        >
                          Edit details
                        </DropdownMenuItem>
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
        noun="employee"
      />

      <EmployeeDialog
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

function EmployeeDialog({
  state,
  onClose,
  onSaved,
}: {
  state: { mode: "create" } | { mode: "edit"; employee: EmployeeRow } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = state?.mode === "edit" ? state.employee : null;

  const form = useForm<EmployeeInput>({
    resolver: zodResolver(employeeSchema),
    defaultValues: emptyValues(),
  });

  const { formError, applyResult, reset } = useServerFormErrors(form);

  const key = editing?.id ?? state?.mode ?? null;
  const [lastKey, setLastKey] = React.useState<string | null>(null);
  if (key !== lastKey) {
    setLastKey(key);
    form.reset(
      editing
        ? {
            name: editing.name,
            email: editing.email ?? "",
            phone: editing.phone ?? "",
            department: editing.department ?? "",
            designation: editing.designation ?? "",
            joiningDate: editing.joiningDate,
            exitDate: editing.exitDate ?? "",
            status: editing.status,
            basicSalary: Number(editing.basicSalary),
            allowances: Number(editing.allowances),
            panNumber: editing.panNumber ?? "",
            bankAccountNo: editing.bankAccountNo ?? "",
            ifsc: editing.ifsc ?? "",
          }
        : emptyValues(),
    );
    reset();
  }

  const status = form.watch("status");
  const hasLeft = status === "RESIGNED" || status === "TERMINATED";
  const basicSalary = form.watch("basicSalary");
  const allowances = form.watch("allowances");

  async function onSubmit(values: EmployeeInput) {
    const result: ActionResult<unknown> = editing
      ? await updateEmployeeAction(editing.id, values)
      : await createEmployeeAction(values);
    if (!applyResult(result)) return;
    onSaved();
  }

  return (
    <Dialog open={Boolean(state)} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit employee" : "Add an employee"}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? `${editing.employeeCode} — changes apply to payroll runs from now on.`
              : "Their terms of employment. A code is assigned automatically."}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
            <FormError message={formError} />

            <div className="grid gap-5 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Full name</FormLabel>
                    <FormControl>
                      <Input autoFocus {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

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
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="designation"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Role
                      <span className="font-normal text-muted-foreground">
                        (optional)
                      </span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="Cashier" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="department"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Department
                      <span className="font-normal text-muted-foreground">
                        (optional)
                      </span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="Sales" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid gap-5 sm:grid-cols-3">
              <FormField
                control={form.control}
                name="joiningDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Joined on</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="status"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Status</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="ACTIVE">Active</SelectItem>
                        <SelectItem value="ON_LEAVE">On leave</SelectItem>
                        <SelectItem value="RESIGNED">Resigned</SelectItem>
                        <SelectItem value="TERMINATED">Terminated</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="exitDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Left on</FormLabel>
                    <FormControl>
                      <Input type="date" disabled={!hasLeft} {...field} />
                    </FormControl>
                    <FormDescription>
                      {hasLeft ? "Required." : "Only for former staff."}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="basicSalary"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Basic salary (monthly)</FormLabel>
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
                name="allowances"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Allowances (monthly)</FormLabel>
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
                      Gross{" "}
                      {formatCurrency((basicSalary || 0) + (allowances || 0), {
                        compactZeroDecimals: true,
                      })}{" "}
                      a month. Nothing is posted until a payroll run.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid gap-5 sm:grid-cols-3">
              <FormField
                control={form.control}
                name="panNumber"
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

              <FormField
                control={form.control}
                name="bankAccountNo"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Bank account
                      <span className="font-normal text-muted-foreground">
                        (optional)
                      </span>
                    </FormLabel>
                    <FormControl>
                      <Input className="font-mono" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="ifsc"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      IFSC
                      <span className="font-normal text-muted-foreground">
                        (optional)
                      </span>
                    </FormLabel>
                    <FormControl>
                      <Input
                        maxLength={11}
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
                  <FormDescription>
                    For payslips. This does not give them access to the
                    application — that is an invitation from Settings.
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
                {editing ? "Save changes" : "Add employee"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
