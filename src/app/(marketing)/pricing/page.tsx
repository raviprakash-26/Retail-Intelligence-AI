import type { Metadata } from "next";
import Link from "next/link";
import { Check, Minus } from "lucide-react";
import { Section, SectionHeading } from "@/components/marketing/section";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  FEATURE,
  PLAN_DEFINITIONS,
  type FeatureKey,
} from "@/lib/billing/plans";
import { formatCurrency } from "@/lib/format";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Straightforward monthly pricing for retail businesses. Start with a 14-day free trial of Professional — no card required.",
};

const COMPARISON_ROWS: ReadonlyArray<{ label: string; feature: FeatureKey }> = [
  { label: "Sales, purchases, expenses", feature: FEATURE.CORE_TRANSACTIONS },
  { label: "Double-entry accounting", feature: FEATURE.ACCOUNTING_BASIC },
  { label: "Financial statements", feature: FEATURE.ACCOUNTING_STATEMENTS },
  { label: "PDF / Excel / CSV export", feature: FEATURE.EXPORTS },
  { label: "Inventory management", feature: FEATURE.INVENTORY },
  { label: "GST preparation", feature: FEATURE.GST_PREPARATION },
  { label: "Tax preparation workspace", feature: FEATURE.TAX_PREPARATION },
  { label: "Business analytics", feature: FEATURE.ANALYTICS },
  { label: "Revenue forecasting", feature: FEATURE.FORECASTING },
  { label: "AI Accountant", feature: FEATURE.AI_ACCOUNTANT },
  { label: "AI Auditor", feature: FEATURE.AI_AUDITOR },
  { label: "AI Business Advisor", feature: FEATURE.AI_ADVISOR },
  { label: "Multi-branch", feature: FEATURE.MULTI_BRANCH },
  {
    label: "Custom roles & permissions",
    feature: FEATURE.ADVANCED_PERMISSIONS,
  },
  { label: "Priority support", feature: FEATURE.PRIORITY_SUPPORT },
];

const LIMIT_ROWS = [
  { label: "Team members", key: "users" as const },
  { label: "Branches", key: "branches" as const },
  { label: "Products", key: "productsPerCompany" as const },
  { label: "Transactions per month", key: "transactionsPerMonth" as const },
  { label: "AI messages per month", key: "aiMessagesPerMonth" as const },
];

function formatLimit(value: number): string {
  if (value < 0) return "Unlimited";
  if (value === 0) return "—";
  return new Intl.NumberFormat("en-IN").format(value);
}

const PRICING_FAQS = [
  {
    question: "What happens when the trial ends?",
    answer:
      "Your data stays exactly where it is. You pick a plan to keep recording transactions; if you do nothing, the account becomes read-only rather than being deleted, and you can still export everything.",
  },
  {
    question: "Can I change plans later?",
    answer:
      "Yes, in either direction, at any time. Moving down a plan hides the features that plan does not include — it never deletes the records you created while on a higher plan.",
  },
  {
    question: "Is there a per-transaction charge?",
    answer:
      "No. Plans have a monthly transaction allowance and the price is fixed. If you consistently exceed the allowance we will tell you before anything changes, not after.",
  },
  {
    question: "How do I pay?",
    answer:
      "Razorpay for Indian customers, with cards, UPI, net banking and wallets. Stripe is supported for customers billing outside India.",
  },
  {
    question: "Do you offer anything for accountants with several clients?",
    answer:
      "Yes — get in touch. A practice managing multiple retail clients needs different packaging from a single shop, and we would rather discuss it than guess.",
  },
];

export default function PricingPage() {
  return (
    <>
      <Section className="pb-10">
        <SectionHeading
          eyebrow="Pricing"
          title="Straightforward pricing. No per-user surprises."
          description="Every plan includes the full double-entry accounting engine — the difference is how much analysis, compliance and AI sits on top of it."
        />
      </Section>

      <Section className="py-0">
        <div className="grid gap-6 lg:grid-cols-3">
          {PLAN_DEFINITIONS.map((plan) => (
            <Card
              key={plan.key}
              className={
                plan.isPopular
                  ? "relative border-primary shadow-md"
                  : "relative"
              }
            >
              {plan.isPopular && (
                <Badge className="absolute -top-2.5 left-6">Most popular</Badge>
              )}
              <CardHeader>
                <CardTitle className="text-lg">{plan.name}</CardTitle>
                <CardDescription>{plan.tagline}</CardDescription>
                <p className="mt-5">
                  <span className="tabular-figures text-4xl font-semibold tracking-tight">
                    {formatCurrency(plan.priceMinor / 100, {
                      compactZeroDecimals: true,
                    })}
                  </span>
                  <span className="text-sm text-muted-foreground"> /month</span>
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {plan.trialDays}-day free trial · Billed monthly
                </p>
              </CardHeader>
              <CardContent>
                <Button
                  variant={plan.isPopular ? "default" : "outline"}
                  className="w-full"
                  size="lg"
                  asChild
                >
                  <Link href="/register">Start free trial</Link>
                </Button>
                <p className="mt-5 text-sm leading-relaxed text-muted-foreground">
                  {plan.description}
                </p>
                <ul className="mt-5 space-y-2.5">
                  {plan.highlights.map((highlight) => (
                    <li key={highlight} className="flex gap-2.5 text-sm">
                      <Check
                        className="mt-0.5 size-4 shrink-0 text-success"
                        strokeWidth={2.5}
                      />
                      <span className="text-muted-foreground">{highlight}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
      </Section>

      <Section>
        <SectionHeading eyebrow="Compare" title="What each plan includes" />

        <div className="mt-10 overflow-x-auto">
          <table className="w-full min-w-[36rem] border-collapse text-sm">
            <caption className="sr-only">
              Feature and usage-limit comparison across the Starter,
              Professional and Business plans
            </caption>
            <thead>
              <tr className="border-b">
                <th scope="col" className="py-3 pr-4 text-left font-medium">
                  Feature
                </th>
                {PLAN_DEFINITIONS.map((plan) => (
                  <th
                    key={plan.key}
                    scope="col"
                    className="px-4 py-3 text-center font-medium"
                  >
                    {plan.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARISON_ROWS.map((row) => (
                <tr key={row.feature} className="border-b">
                  <th
                    scope="row"
                    className="py-3 pr-4 text-left font-normal text-muted-foreground"
                  >
                    {row.label}
                  </th>
                  {PLAN_DEFINITIONS.map((plan) => {
                    const included = plan.features.includes(row.feature);
                    return (
                      <td key={plan.key} className="px-4 py-3 text-center">
                        {included ? (
                          <>
                            <Check
                              className="mx-auto size-4 text-success"
                              strokeWidth={2.5}
                              aria-hidden="true"
                            />
                            <span className="sr-only">Included</span>
                          </>
                        ) : (
                          <>
                            <Minus
                              className="mx-auto size-4 text-muted-foreground/40"
                              aria-hidden="true"
                            />
                            <span className="sr-only">Not included</span>
                          </>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}

              <tr>
                <th
                  scope="row"
                  colSpan={PLAN_DEFINITIONS.length + 1}
                  className="pt-8 pb-2 text-left text-sm font-semibold"
                >
                  Usage limits
                </th>
              </tr>
              {LIMIT_ROWS.map((row) => (
                <tr key={row.key} className="border-b">
                  <th
                    scope="row"
                    className="py-3 pr-4 text-left font-normal text-muted-foreground"
                  >
                    {row.label}
                  </th>
                  {PLAN_DEFINITIONS.map((plan) => (
                    <td
                      key={plan.key}
                      className="tabular-figures px-4 py-3 text-center"
                    >
                      {formatLimit(plan.limits[row.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-6 text-xs text-muted-foreground">
          Prices in Indian Rupees, exclusive of applicable taxes. Limits are
          enforced as entitlements on your subscription and can be adjusted for
          your account on request.
        </p>
      </Section>

      <Section className="border-t bg-muted/40">
        <SectionHeading eyebrow="Billing" title="Pricing questions" />
        <div className="mx-auto mt-10 max-w-3xl">
          <Accordion type="single" collapsible>
            {PRICING_FAQS.map((faq, index) => (
              <AccordionItem key={faq.question} value={`pricing-faq-${index}`}>
                <AccordionTrigger>{faq.question}</AccordionTrigger>
                <AccordionContent>{faq.answer}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </Section>
    </>
  );
}
