"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { CircleCheck, Info, Lock, Save } from "lucide-react";
import { FormError } from "@/components/auth/form-error";
import { useServerFormErrors } from "@/components/auth/use-action-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fiscalYearLabel } from "@/lib/constants/india";
import {
  companyAccountingSchema,
  type CompanyAccountingInput,
} from "@/lib/validation/company";
import { updateAccountingSettingsAction } from "@/server/company/actions";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const TIMEZONES = [
  "Asia/Kolkata",
  "Asia/Dubai",
  "Asia/Singapore",
  "Europe/London",
  "America/New_York",
  "UTC",
] as const;

export type LockInfo = {
  field: string;
  locked: boolean;
  reason: string | null;
};

/**
 * A locked field is shown disabled *with its reason*, not merely greyed out.
 * "You cannot change this" without a why is how support tickets are made.
 */
function LockNote({ lock }: { lock: LockInfo | undefined }) {
  if (!lock?.locked || !lock.reason) return null;
  return (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <Lock className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
      {lock.reason}
    </p>
  );
}

export function AccountingSettingsForm({
  defaultValues,
  locks,
  readOnly,
}: {
  defaultValues: CompanyAccountingInput;
  locks: LockInfo[];
  readOnly: boolean;
}) {
  const form = useForm<CompanyAccountingInput>({
    resolver: zodResolver(companyAccountingSchema),
    defaultValues,
  });

  const { formError, applyResult } = useServerFormErrors(form);
  const [saved, setSaved] = React.useState(false);
  const startMonth = form.watch("fiscalYearStartMonth");

  const lockFor = (field: string) => locks.find((lock) => lock.field === field);
  const isLocked = (field: string) => Boolean(lockFor(field)?.locked);

  async function onSubmit(values: CompanyAccountingInput) {
    setSaved(false);
    const result = await updateAccountingSettingsAction(values);
    if (!applyResult(result)) return;
    setSaved(true);
    form.reset(values);
  }

  const anyLocked = locks.some((lock) => lock.locked);

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        <FormError message={formError} />

        {saved && !formError && (
          <Alert variant="success">
            <CircleCheck />
            <AlertDescription>
              <p>Your accounting settings have been saved.</p>
            </AlertDescription>
          </Alert>
        )}

        {anyLocked && (
          <Alert variant="info">
            <Info />
            <AlertTitle>
              Some settings are fixed now that you have posted
            </AlertTitle>
            <AlertDescription>
              <p>
                These decisions shape how every existing figure was recorded, so
                changing them after the fact would rewrite the meaning of your
                history rather than update it. Each locked field explains itself
                below.
              </p>
            </AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Financial year</CardTitle>
            <CardDescription>
              When your accounting year begins. April is the Indian standard.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <FormField
              control={form.control}
              name="fiscalYearStartMonth"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Financial year starts in</FormLabel>
                  <Select
                    onValueChange={(value) => field.onChange(Number(value))}
                    value={String(field.value)}
                    disabled={readOnly || isLocked("fiscalYearStartMonth")}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {MONTHS.map((month, index) => (
                        <SelectItem key={month} value={String(index + 1)}>
                          {month}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Your current financial year is{" "}
                    <span className="font-medium text-foreground">
                      {fiscalYearLabel(new Date(), startMonth)}
                    </span>
                    .
                  </FormDescription>
                  <LockNote lock={lockFor("fiscalYearStartMonth")} />
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Currency and valuation</CardTitle>
            <CardDescription>
              How amounts are denominated and how stock cost is calculated.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <FormField
              control={form.control}
              name="currency"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Currency</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value}
                    disabled={readOnly || isLocked("currency")}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="INR">Indian Rupee (₹)</SelectItem>
                      <SelectItem value="USD">US Dollar ($)</SelectItem>
                      <SelectItem value="AED">UAE Dirham (د.إ)</SelectItem>
                      <SelectItem value="GBP">Pound Sterling (£)</SelectItem>
                    </SelectContent>
                  </Select>
                  <LockNote lock={lockFor("currency")} />
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="inventoryMethod"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Stock valuation method</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value}
                    disabled={readOnly || isLocked("inventoryMethod")}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="WEIGHTED_AVERAGE">
                        Weighted average
                      </SelectItem>
                      <SelectItem value="FIFO">
                        First in, first out (FIFO)
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    How cost of goods sold is calculated when the same item was
                    bought at different prices.
                  </FormDescription>
                  <LockNote lock={lockFor("inventoryMethod")} />
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="timezone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Time zone</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value}
                    disabled={readOnly}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {TIMEZONES.map((zone) => (
                        <SelectItem key={zone} value={zone}>
                          {zone.replace("_", " ")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Decides which day a transaction recorded late at night
                    belongs to.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        {!readOnly && (
          <div className="flex justify-end">
            <Button
              type="submit"
              size="lg"
              loading={form.formState.isSubmitting}
              loadingText="Saving…"
              disabled={!form.formState.isDirty}
            >
              <Save className="size-4" />
              Save changes
            </Button>
          </div>
        )}
      </form>
    </Form>
  );
}
