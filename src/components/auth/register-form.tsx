"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, ArrowRight, Building2, Info } from "lucide-react";
import { AuthBackendNotice } from "@/components/auth/phase-notice";
import { PasswordField } from "@/components/auth/password-field";
import { PasswordStrengthMeter } from "@/components/auth/password-strength";
import {
  REGISTER_STEPS,
  RegisterStepper,
} from "@/components/auth/register-stepper";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AmountInput } from "@/components/ui/amount-input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Separator } from "@/components/ui/separator";
import {
  BUSINESS_TYPE_OPTIONS,
  GST_REGISTRATION_OPTIONS,
  INDIAN_STATES,
  fiscalYearLabel,
} from "@/lib/constants/india";
import { formatCurrency } from "@/lib/format";
import {
  registerAccountingSchema,
  registerAccountSchema,
  registerBusinessSchema,
  type RegisterAccountingInput,
  type RegisterAccountInput,
  type RegisterBusinessInput,
} from "@/lib/validation/auth";

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

/**
 * Three-step registration.
 *
 * Each step owns its own form instance and is validated before the wizard
 * advances, so a person cannot reach step 3 with an invalid GSTIN behind them.
 * Completed steps are held in component state; the whole payload is submitted
 * once at the end as a single transaction (Phase 2), because a half-created
 * tenant — a user with no company, or a company with no chart of accounts —
 * is worse than no tenant at all.
 */
export function RegisterForm() {
  const [step, setStep] = React.useState(1);
  const [account, setAccount] = React.useState<RegisterAccountInput | null>(
    null,
  );
  const [business, setBusiness] = React.useState<RegisterBusinessInput | null>(
    null,
  );
  const [submitted, setSubmitted] = React.useState(false);

  const headingRef = React.useRef<HTMLHeadingElement>(null);

  // Move focus to the new step's heading so a keyboard or screen-reader user
  // is not left focused on a button that has just been replaced.
  React.useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="text-2xl font-semibold tracking-tight outline-none"
        >
          {step === 1 && "Create your account"}
          {step === 2 && "Tell us about your business"}
          {step === 3 && "Set up your books"}
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {step === 1 &&
            "Two minutes to set up. No card required for the 14-day trial."}
          {step === 2 &&
            "This determines how your invoices and GST working are prepared."}
          {step === 3 &&
            "Your opening position. You can change all of this later in Settings."}
        </p>
      </div>

      <RegisterStepper current={step} />

      {submitted && <AuthBackendNotice action="creating your account" />}

      {step === 1 && (
        <AccountStep
          defaultValues={account}
          onNext={(values) => {
            setAccount(values);
            setStep(2);
          }}
        />
      )}

      {step === 2 && (
        <BusinessStep
          defaultValues={business}
          onBack={() => setStep(1)}
          onNext={(values) => {
            setBusiness(values);
            setStep(3);
          }}
        />
      )}

      {step === 3 && (
        <AccountingStep
          businessName={business?.businessName ?? "your business"}
          onBack={() => setStep(2)}
          onSubmit={() => setSubmitted(true)}
        />
      )}

      <p className="text-center text-xs text-muted-foreground">
        Step {step} of {REGISTER_STEPS.length}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — the person
// ---------------------------------------------------------------------------

function AccountStep({
  defaultValues,
  onNext,
}: {
  defaultValues: RegisterAccountInput | null;
  onNext: (values: RegisterAccountInput) => void;
}) {
  const form = useForm<RegisterAccountInput>({
    resolver: zodResolver(registerAccountSchema),
    defaultValues: defaultValues ?? {
      fullName: "",
      email: "",
      mobile: "",
      password: "",
      confirmPassword: "",
      acceptTerms: false,
    },
  });

  const password = form.watch("password");
  const email = form.watch("email");
  const fullName = form.watch("fullName");

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onNext)} className="space-y-5">
        <FormField
          control={form.control}
          name="fullName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Full name</FormLabel>
              <FormControl>
                <Input
                  placeholder="Ravi Prakash"
                  autoComplete="name"
                  {...field}
                />
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
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input
                  type="email"
                  placeholder="you@business.com"
                  autoComplete="email"
                  {...field}
                />
              </FormControl>
              <FormDescription>
                This is how you sign in, and where password resets are sent.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="mobile"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Mobile number</FormLabel>
              <FormControl>
                <Input
                  type="tel"
                  inputMode="tel"
                  placeholder="98765 43210"
                  autoComplete="tel"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Password</FormLabel>
              <FormControl>
                <PasswordField
                  placeholder="At least 10 characters"
                  autoComplete="new-password"
                  {...field}
                />
              </FormControl>
              <PasswordStrengthMeter
                password={password}
                email={email}
                name={fullName}
              />
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="confirmPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Confirm password</FormLabel>
              <FormControl>
                <PasswordField
                  placeholder="Re-enter your password"
                  autoComplete="new-password"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="acceptTerms"
          render={({ field }) => (
            <FormItem className="flex flex-row items-start gap-2.5">
              <FormControl>
                <Checkbox
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  className="mt-0.5"
                />
              </FormControl>
              <div className="space-y-1">
                <FormLabel className="text-sm leading-relaxed font-normal text-muted-foreground">
                  I agree to the Terms of Service and Privacy Policy.
                </FormLabel>
                <FormMessage />
              </div>
            </FormItem>
          )}
        />

        <Button type="submit" size="lg" className="w-full">
          Continue
          <ArrowRight className="size-4" />
        </Button>
      </form>
    </Form>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — the business
// ---------------------------------------------------------------------------

function BusinessStep({
  defaultValues,
  onBack,
  onNext,
}: {
  defaultValues: RegisterBusinessInput | null;
  onBack: () => void;
  onNext: (values: RegisterBusinessInput) => void;
}) {
  const form = useForm<RegisterBusinessInput>({
    resolver: zodResolver(registerBusinessSchema),
    defaultValues: defaultValues ?? {
      businessName: "",
      businessType: "SOLE_PROPRIETORSHIP",
      gstRegistration: "UNREGISTERED",
      gstin: "",
      pan: "",
      addressLine1: "",
      city: "",
      stateCode: "",
      pincode: "",
    },
  });

  const gstRegistration = form.watch("gstRegistration");
  const gstRequired = gstRegistration !== "UNREGISTERED";

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onNext)} className="space-y-5">
        <FormField
          control={form.control}
          name="businessName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Business name</FormLabel>
              <FormControl>
                <Input
                  placeholder="Ravi Retail Mart"
                  autoComplete="organization"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="businessType"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Business type</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {BUSINESS_TYPE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
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
          name="gstRegistration"
          render={({ field }) => (
            <FormItem>
              <FormLabel>GST registration</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {GST_REGISTRATION_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormDescription>
                {
                  GST_REGISTRATION_OPTIONS.find(
                    (option) => option.value === gstRegistration,
                  )?.hint
                }
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid gap-5 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="gstin"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  GSTIN
                  {!gstRequired && (
                    <span className="font-normal text-muted-foreground">
                      (optional)
                    </span>
                  )}
                </FormLabel>
                <FormControl>
                  <Input
                    placeholder="29ABCDE1234F1Z5"
                    maxLength={15}
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
                    placeholder="ABCDE1234F"
                    maxLength={10}
                    className="uppercase"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <Separator />

        <FormField
          control={form.control}
          name="addressLine1"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Address</FormLabel>
              <FormControl>
                <Input
                  placeholder="12 Market Road, Gandhi Nagar"
                  autoComplete="street-address"
                  {...field}
                />
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
                  <Input
                    placeholder="Bengaluru"
                    autoComplete="address-level2"
                    {...field}
                  />
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
                  <Input
                    inputMode="numeric"
                    placeholder="560001"
                    maxLength={6}
                    autoComplete="postal-code"
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
          name="stateCode"
          render={({ field }) => (
            <FormItem>
              <FormLabel>State</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Select your state" />
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
              <FormDescription>
                Your state decides whether a sale is taxed as CGST + SGST or as
                IGST.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex gap-3">
          <Button type="button" variant="outline" size="lg" onClick={onBack}>
            <ArrowLeft className="size-4" />
            Back
          </Button>
          <Button type="submit" size="lg" className="flex-1">
            Continue
            <ArrowRight className="size-4" />
          </Button>
        </div>
      </form>
    </Form>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — the books
// ---------------------------------------------------------------------------

function AccountingStep({
  businessName,
  onBack,
  onSubmit,
}: {
  businessName: string;
  onBack: () => void;
  onSubmit: () => void;
}) {
  const form = useForm<RegisterAccountingInput>({
    resolver: zodResolver(registerAccountingSchema),
    defaultValues: {
      fiscalYearStartMonth: 4,
      currency: "INR",
      openingCapital: 0,
      openingCashBalance: 0,
      openingBankBalance: 0,
      inventoryMethod: "WEIGHTED_AVERAGE",
      loadDemoData: false,
    },
  });

  const startMonth = form.watch("fiscalYearStartMonth");
  const capital = form.watch("openingCapital");
  const cash = form.watch("openingCashBalance");
  const bank = form.watch("openingBankBalance");

  // The opening entry must balance: assets introduced are matched by capital.
  // Showing the difference live means a user fixes it here rather than
  // discovering an unbalanced opening balance in their first trial balance.
  const difference = capital - (cash + bank);

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
        <FormField
          control={form.control}
          name="fiscalYearStartMonth"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Financial year starts in</FormLabel>
              <Select
                onValueChange={(value) => field.onChange(Number(value))}
                value={String(field.value)}
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
                Your current financial year will be{" "}
                <span className="font-medium text-foreground">
                  {fiscalYearLabel(new Date(), startMonth)}
                </span>
                . April is the Indian standard.
              </FormDescription>
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
              <Select onValueChange={field.onChange} value={field.value}>
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
                How the cost of goods sold is calculated when you buy the same
                item at different prices.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <Separator />

        <div className="space-y-1">
          <p className="text-sm font-medium">Opening balances</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            What {businessName} already has, on the day you start using the
            system. Leave these at zero if you would rather set them up later.
          </p>
        </div>

        <FormField
          control={form.control}
          name="openingCapital"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Owner&rsquo;s capital</FormLabel>
              <FormControl>
                <AmountInput
                  prefix="₹"
                  min={0}
                  step="0.01"
                  value={field.value}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  name={field.name}
                  ref={field.ref}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid gap-5 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="openingCashBalance"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Cash in hand</FormLabel>
                <FormControl>
                  <AmountInput
                    prefix="₹"
                    min={0}
                    step="0.01"
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    name={field.name}
                    ref={field.ref}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="openingBankBalance"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Bank balance</FormLabel>
                <FormControl>
                  <AmountInput
                    prefix="₹"
                    min={0}
                    step="0.01"
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    name={field.name}
                    ref={field.ref}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {(capital > 0 || cash > 0 || bank > 0) && (
          <Alert variant={difference === 0 ? "success" : "info"}>
            <Info />
            <AlertDescription>
              {difference === 0 ? (
                <p>
                  Your opening entry balances: capital of{" "}
                  <span className="tabular-figures font-medium">
                    {formatCurrency(capital)}
                  </span>{" "}
                  against cash and bank of the same amount.
                </p>
              ) : (
                <p>
                  Capital and opening assets differ by{" "}
                  <span className="tabular-figures font-medium">
                    {formatCurrency(Math.abs(difference))}
                  </span>
                  . That is fine — the difference will be posted to your capital
                  account so the opening entry balances.
                </p>
              )}
            </AlertDescription>
          </Alert>
        )}

        <Separator />

        <FormField
          control={form.control}
          name="loadDemoData"
          render={({ field }) => (
            <FormItem className="flex flex-row items-start gap-2.5 rounded-lg border bg-muted/40 p-4">
              <FormControl>
                <Checkbox
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  className="mt-0.5"
                />
              </FormControl>
              <div className="space-y-1">
                <FormLabel className="font-medium">
                  <Building2 className="size-3.5 text-muted-foreground" />
                  Load sample data so I can look around first
                </FormLabel>
                <FormDescription>
                  Creates a demo retail business with products, customers and a
                  few months of transactions. Everything is clearly marked as
                  demo data and can be cleared in one click.
                </FormDescription>
              </div>
            </FormItem>
          )}
        />

        <div className="flex gap-3">
          <Button type="button" variant="outline" size="lg" onClick={onBack}>
            <ArrowLeft className="size-4" />
            Back
          </Button>
          <Button
            type="submit"
            size="lg"
            className="flex-1"
            loading={form.formState.isSubmitting}
          >
            Create account
            <ArrowRight className="size-4" />
          </Button>
        </div>
      </form>
    </Form>
  );
}
