"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { FormError } from "@/components/auth/form-error";
import { useServerFormErrors } from "@/components/auth/use-action-form";
import { AmountInput } from "@/components/ui/amount-input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Label } from "@/components/ui/label";
import {
  payrollPolicySchema,
  type PayrollPolicyInput,
} from "@/lib/validation/payroll";
import { updatePayrollPolicyAction } from "@/server/payroll/actions";

/**
 * Which statutory schemes the business is registered under.
 *
 * Deliberately a question rather than a setting with a clever default. Whether
 * a shop is covered by EPF or ESI depends on its headcount, its registration
 * and when it crossed the threshold — none of which this product knows, and
 * all of which it would be guessing at. Both start off, and the page says what
 * turning them on will do to the next payslip.
 */
export function PayrollPolicyForm({
  defaultValues,
  readOnly,
}: {
  defaultValues: PayrollPolicyInput;
  readOnly: boolean;
}) {
  const router = useRouter();
  const [saved, setSaved] = React.useState(false);

  const form = useForm<PayrollPolicyInput>({
    resolver: zodResolver(payrollPolicySchema),
    defaultValues,
  });
  const { formError, applyResult } = useServerFormErrors(form);

  async function onSubmit(values: PayrollPolicyInput) {
    const result = await updatePayrollPolicyAction(values);
    if (!applyResult(result)) return;
    setSaved(true);
    router.refresh();
  }

  const hasProfessionalTax = form.watch("professionalTaxMonthly") !== null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Statutory deductions</CardTitle>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
            <FormError message={formError} />

            <FormField
              control={form.control}
              name="providentFund"
              render={({ field }) => (
                <FormItem className="flex items-start gap-3">
                  <FormControl>
                    <Checkbox
                      checked={field.value}
                      onCheckedChange={field.onChange}
                      disabled={readOnly}
                    />
                  </FormControl>
                  <div className="space-y-1">
                    <FormLabel>Registered under EPF</FormLabel>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      12% of basic pay is withheld and the business contributes
                      12% again, both on the first ₹15,000 of monthly basic.
                    </p>
                  </div>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="employeeStateInsurance"
              render={({ field }) => (
                <FormItem className="flex items-start gap-3">
                  <FormControl>
                    <Checkbox
                      checked={field.value}
                      onCheckedChange={field.onChange}
                      disabled={readOnly}
                    />
                  </FormControl>
                  <div className="space-y-1">
                    <FormLabel>Registered under ESI</FormLabel>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      0.75% from the employee and 3.25% from the business, on
                      gross pay. An employee earning above ₹21,000 a month is
                      outside the scheme entirely rather than capped.
                    </p>
                  </div>
                </FormItem>
              )}
            />

            <div className="space-y-2 border-t pt-5">
              <div className="flex items-start gap-3">
                <Checkbox
                  id="pt-enabled"
                  checked={hasProfessionalTax}
                  disabled={readOnly}
                  onCheckedChange={(checked) => {
                    form.setValue(
                      "professionalTaxMonthly",
                      checked ? 200 : null,
                      { shouldDirty: true },
                    );
                    // Karnataka's slab, offered whole rather than half. Both
                    // figures are the state's, and offering only the amount is
                    // what left businesses elsewhere on Bengaluru's threshold.
                    form.setValue(
                      "professionalTaxThreshold",
                      checked ? 25000 : null,
                      { shouldDirty: true },
                    );
                  }}
                />
                <div className="space-y-1">
                  <Label htmlFor="pt-enabled">
                    This state levies professional tax
                  </Label>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    A flat monthly figure, levied above a wage the state fixes.
                    Both are set here rather than guessed from your address,
                    because every state differs — Karnataka&rsquo;s ₹200 above
                    ₹25,000 is offered as a starting point.
                  </p>
                </div>
              </div>

              {hasProfessionalTax && (
                <FormField
                  control={form.control}
                  name="professionalTaxMonthly"
                  render={({ field }) => (
                    <FormItem className="pl-7">
                      <FormLabel className="text-xs text-muted-foreground">
                        Monthly amount
                      </FormLabel>
                      <FormControl>
                        <AmountInput
                          value={field.value ?? 0}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                          disabled={readOnly}
                          prefix="₹"
                          className="w-40"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              {hasProfessionalTax && (
                <FormField
                  control={form.control}
                  name="professionalTaxThreshold"
                  render={({ field }) => (
                    <FormItem className="pl-7">
                      <FormLabel className="text-xs text-muted-foreground">
                        Levied above
                      </FormLabel>
                      <FormControl>
                        <AmountInput
                          value={field.value ?? 0}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                          disabled={readOnly}
                          prefix="₹"
                          className="w-40"
                        />
                      </FormControl>
                      <p className="text-xs text-muted-foreground">
                        Monthly gross. Staff earning this or less have none
                        withheld.
                      </p>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
            </div>

            <p className="rounded-lg border bg-muted/30 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
              <strong className="font-medium text-foreground">
                TDS is not on this list.
              </strong>{" "}
              Tax on salary depends on each employee&rsquo;s projected annual
              income, the regime they elected and what they declared. This
              platform does not work it out — enter the figure yourself when you
              run payroll, or leave it at nil.
            </p>

            {!readOnly && (
              <div className="flex items-center gap-3">
                <Button
                  type="submit"
                  loading={form.formState.isSubmitting}
                  loadingText="Saving…"
                >
                  Save
                </Button>
                {saved && !form.formState.isDirty && (
                  <span className="text-sm text-muted-foreground">Saved.</span>
                )}
              </div>
            )}
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
