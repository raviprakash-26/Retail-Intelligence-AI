import Link from "next/link";
import {
  ArrowRight,
  Check,
  CircleAlert,
  Database,
  FileCheck2,
  Lock,
  Sparkles,
} from "lucide-react";
import { getFeatureIcon } from "@/components/marketing/feature-icon";
import { ProductPreview } from "@/components/marketing/product-preview";
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
  faqs,
  features,
  problems,
  trustPoints,
  workflowSteps,
} from "@/config/site";
import { PLAN_DEFINITIONS } from "@/lib/billing/plans";
import { formatCurrency } from "@/lib/format";

const TRUST_ICONS = [FileCheck2, Database, Lock, Sparkles] as const;

export default function HomePage() {
  return (
    <>
      {/* ================= HERO ================= */}
      <section className="bg-brand-glow relative overflow-hidden px-4 pt-16 pb-20 sm:px-6 lg:px-8 lg:pt-24">
        <div
          className="bg-grid pointer-events-none absolute inset-0 -z-10 opacity-40"
          aria-hidden="true"
        />
        <div className="mx-auto w-full max-w-6xl">
          <div className="mx-auto max-w-3xl text-center">
            <Badge variant="outline" className="mx-auto gap-1.5 bg-card py-1">
              <Sparkles className="size-3 text-ai" />
              Accounting, auditing and forecasting in one place
            </Badge>

            <h1 className="mt-6 text-4xl font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl">
              Your <span className="text-gradient-brand">AI Accountant</span>{" "}
              for everyday retail business.
            </h1>

            <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-pretty text-muted-foreground sm:text-lg">
              Record your transactions once. Retail Intelligence AI
              automatically generates your accounts, financial statements, GST
              working, business insights and forecasts — from a proper
              double-entry ledger, not a spreadsheet of totals.
            </p>

            <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Button size="xl" asChild className="w-full sm:w-auto">
                <Link href="/register">
                  Start free
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
              <Button
                size="xl"
                variant="outline"
                asChild
                className="w-full sm:w-auto"
              >
                <Link href="/features">View demo</Link>
              </Button>
            </div>

            <p className="mt-5 text-xs text-muted-foreground">
              14-day free trial · No card required · Cancel any time
            </p>
          </div>

          <div className="relative mt-16">
            <ProductPreview />
          </div>
        </div>
      </section>

      {/* ================= TRUST BAR ================= */}
      <section className="border-y">
        <div className="mx-auto grid w-full max-w-6xl gap-px px-4 sm:px-6 md:grid-cols-2 lg:grid-cols-4 lg:px-8">
          {trustPoints.map((point, index) => {
            const Icon = TRUST_ICONS[index] ?? FileCheck2;
            return (
              <div
                key={point.title}
                className="flex gap-3 border-b py-6 last:border-b-0 md:border-b-0 md:py-8 lg:px-6 lg:first:pl-0 lg:last:pr-0"
              >
                <Icon className="mt-0.5 size-5 shrink-0 text-primary" />
                <div>
                  <p className="text-sm font-semibold">{point.title}</p>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    {point.description}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ================= PROBLEM ================= */}
      <Section>
        <SectionHeading
          eyebrow="The problem"
          title="Most retail businesses do not have bad accounting. They have no accounting."
          description="Not because owners do not care, but because the tools built for this were designed for accountants, and the alternative is a notebook."
        />

        <div className="mt-14 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {problems.map((problem) => (
            <Card key={problem.title} className="card-hover">
              <CardHeader>
                <CircleAlert
                  className="size-5 text-muted-foreground/60"
                  aria-hidden="true"
                />
                <CardTitle className="mt-1 text-base">
                  {problem.title}
                </CardTitle>
                <CardDescription className="mt-1.5 leading-relaxed">
                  {problem.description}
                </CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </Section>

      {/* ================= SOLUTION / WORKFLOW ================= */}
      <Section className="border-y bg-muted/40">
        <SectionHeading
          eyebrow="How it works"
          title="One entry. Everything downstream updates itself."
          description="You record what happened. The system works out what it means for your accounts, your stock, your tax position and your reports."
        />

        <ol className="mt-14 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          {workflowSteps.map((step, index) => (
            <li key={step.step} className="relative">
              <Card className="h-full">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <span className="tabular-figures flex size-8 items-center justify-center rounded-lg bg-primary text-xs font-semibold text-primary-foreground">
                      {step.step}
                    </span>
                    {index < workflowSteps.length - 1 && (
                      <span
                        className="hidden h-px flex-1 bg-border lg:block"
                        aria-hidden="true"
                      />
                    )}
                  </div>
                  <CardTitle className="mt-3 text-base">{step.title}</CardTitle>
                  <CardDescription className="mt-1.5 leading-relaxed">
                    {step.description}
                  </CardDescription>
                </CardHeader>
              </Card>
            </li>
          ))}
        </ol>
      </Section>

      {/* ================= FEATURES ================= */}
      <Section>
        <SectionHeading
          eyebrow="Features"
          title="Everything a retail business actually needs to stay on top of its money."
          description="Built around a single accounting engine, so the numbers on every screen come from the same source of truth."
        />

        <div className="mt-14 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => {
            const Icon = getFeatureIcon(feature.icon);
            return (
              <Card key={feature.title} className="card-hover group">
                <CardHeader>
                  <div className="flex size-10 items-center justify-center rounded-lg bg-primary-muted text-primary transition-colors">
                    <Icon className="size-5" aria-hidden="true" />
                  </div>
                  <CardTitle className="mt-3.5 flex items-center gap-2 text-base">
                    {feature.title}
                    {feature.availableFrom !== "starter" && (
                      <Badge
                        variant="muted"
                        className="text-[0.625rem] font-normal"
                      >
                        {feature.availableFrom === "business"
                          ? "Business"
                          : "Professional"}
                      </Badge>
                    )}
                  </CardTitle>
                  <CardDescription className="mt-1.5 leading-relaxed">
                    {feature.description}
                  </CardDescription>
                </CardHeader>
              </Card>
            );
          })}
        </div>
      </Section>

      {/* ================= ACCOUNTING INTEGRITY ================= */}
      <Section className="border-y bg-muted/40">
        <div className="grid items-center gap-14 lg:grid-cols-2">
          <div>
            <SectionHeading
              align="left"
              eyebrow="Why this is different"
              title="The accounting is real accounting."
              description="Plenty of tools add up your sales, subtract your expenses and call the result profit. That number is not wrong by accident — it is wrong by construction, because it ignores stock, credit, tax and everything on the balance sheet."
            />

            <ul className="mt-8 space-y-4">
              {[
                {
                  title: "Every transaction becomes a balanced journal entry",
                  body: "Sales, purchases, expenses, receipts and payments all pass through one rules engine. Nothing writes to the ledger directly.",
                },
                {
                  title: "Balance is enforced by the database",
                  body: "Check constraints and triggers reject an unbalanced entry outright. It is not possible for a bug in one module to corrupt your books.",
                },
                {
                  title: "Statements are derived, never assembled",
                  body: "Trial balance, trading account, P&L and balance sheet are computed from journal lines. The trial balance is validated before any statement renders.",
                },
                {
                  title: "Posted history is immutable",
                  body: "Corrections happen through reversing entries with a stated reason. Your audit trail survives contact with reality.",
                },
              ].map((item) => (
                <li key={item.title} className="flex gap-3">
                  <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-success-muted text-success">
                    <Check className="size-3" strokeWidth={3} />
                  </span>
                  <div>
                    <p className="text-sm font-medium">{item.title}</p>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                      {item.body}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <Card className="overflow-hidden">
            <CardHeader className="border-b bg-muted/40 pb-6">
              <CardTitle className="text-sm">
                What one credit sale actually touches
              </CardTitle>
              <CardDescription>
                Rice · 100 kg · ₹45,000 + 18% GST · sold on credit
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-6">
              <ul className="divide-y divide-border text-sm">
                {[
                  ["Sales invoice", "INV-0142 recorded and numbered"],
                  ["Inventory", "100 kg issued, stock value reduced"],
                  ["Cost of goods sold", "Cost recognised at valuation rate"],
                  ["Customer ledger", "₹53,100 added to receivables"],
                  ["GST output", "CGST ₹4,050 + SGST ₹4,050 recorded"],
                  ["Journal & ledger", "Balanced entry posted to 4 accounts"],
                  ["Trial balance", "Recomputed and re-validated"],
                  [
                    "Financial statements",
                    "Trading, P&L and balance sheet updated",
                  ],
                  [
                    "Analytics & forecasts",
                    "Revenue, margin and cash series refreshed",
                  ],
                ].map(([label, detail]) => (
                  <li
                    key={label}
                    className="flex items-baseline justify-between gap-4 py-2.5"
                  >
                    <span className="font-medium">{label}</span>
                    <span className="text-right text-xs text-muted-foreground">
                      {detail}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </Section>

      {/* ================= AI ================= */}
      <Section>
        <SectionHeading
          eyebrow="AI, used honestly"
          title="The AI explains your business. It does not invent your numbers."
          description="Profit, GST, ledger balances, ratios and statements are calculated by application code from your posted transactions. The AI reads those results through defined queries and tells you what they mean."
        />

        <div className="mt-14 grid gap-5 md:grid-cols-3">
          {[
            {
              title: "AI Accountant",
              body: "Ask “why did profit fall?” or “how much do customers owe me?” and get an answer built from your ledger, with the period and figures it used.",
              badge: "Answers cite their source",
            },
            {
              title: "AI Auditor",
              body: "Continuous checks for duplicate invoices, missing numbers, negative stock, unusual amounts and GST mismatches, scored into a deterministic audit score.",
              badge: "Flags risk, never alleges fraud",
            },
            {
              title: "AI Business Advisor",
              body: "Short, specific observations tied to the data behind them — which product carries your margin, which expense is growing fastest, what to look at next.",
              badge: "Every claim links to data",
            },
          ].map((item) => (
            <Card key={item.title} className="border-ai/20 bg-ai-muted/30">
              <CardHeader>
                <div className="flex size-10 items-center justify-center rounded-lg bg-ai/10 text-ai">
                  <Sparkles className="size-5" aria-hidden="true" />
                </div>
                <CardTitle className="mt-3.5 text-base">{item.title}</CardTitle>
                <CardDescription className="mt-1.5 leading-relaxed">
                  {item.body}
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <Badge variant="ai" className="text-[0.6875rem]">
                  {item.badge}
                </Badge>
              </CardContent>
            </Card>
          ))}
        </div>
      </Section>

      {/* ================= PRICING PREVIEW ================= */}
      <Section className="border-y bg-muted/40">
        <SectionHeading
          eyebrow="Pricing"
          title="Priced for a shop, not an enterprise."
          description="Start on a 14-day trial of Professional. Move to any plan, or down to Starter, whenever you like."
        />

        <div className="mt-14 grid gap-6 lg:grid-cols-3">
          {PLAN_DEFINITIONS.map((plan) => (
            <Card
              key={plan.key}
              className={
                plan.isPopular ? "relative border-primary shadow-md" : ""
              }
            >
              {plan.isPopular && (
                <Badge className="absolute -top-2.5 left-6">Most popular</Badge>
              )}
              <CardHeader>
                <CardTitle className="text-lg">{plan.name}</CardTitle>
                <CardDescription>{plan.tagline}</CardDescription>
                <p className="mt-4">
                  <span className="tabular-figures text-3xl font-semibold tracking-tight">
                    {formatCurrency(plan.priceMinor / 100, {
                      compactZeroDecimals: true,
                    })}
                  </span>
                  <span className="text-sm text-muted-foreground"> /month</span>
                </p>
              </CardHeader>
              <CardContent className="pt-2">
                <Button
                  variant={plan.isPopular ? "default" : "outline"}
                  className="w-full"
                  asChild
                >
                  <Link href="/register">Start free trial</Link>
                </Button>
                <ul className="mt-6 space-y-2.5">
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

        <p className="mt-8 text-center text-xs text-muted-foreground">
          Prices in Indian Rupees, exclusive of applicable taxes.
        </p>
      </Section>

      {/* ================= FAQ ================= */}
      <Section>
        <SectionHeading
          eyebrow="Questions"
          title="The things people ask before they trust software with their books."
        />

        <div className="mx-auto mt-12 max-w-3xl">
          <Accordion type="single" collapsible className="w-full">
            {faqs.map((faq, index) => (
              <AccordionItem key={faq.question} value={`faq-${index}`}>
                <AccordionTrigger>{faq.question}</AccordionTrigger>
                <AccordionContent>{faq.answer}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </Section>

      {/* ================= CTA ================= */}
      <Section className="border-t pt-4 pb-24">
        <Card className="border-none bg-primary text-primary-foreground">
          <CardContent className="flex flex-col items-center gap-6 px-6 py-14 text-center sm:px-12">
            <h2 className="max-w-2xl text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
              Find out what your business actually earned last month.
            </h2>
            <p className="max-w-xl leading-relaxed text-pretty text-primary-foreground/80">
              Set up your business in a few minutes, record a handful of
              transactions, and see a real trial balance and profit &amp; loss
              come out the other side.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button size="xl" variant="secondary" asChild>
                <Link href="/register">
                  Start free
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
              <Button
                size="xl"
                variant="outline"
                asChild
                className="border-primary-foreground/25 bg-transparent text-current hover:bg-primary-foreground/10 hover:text-current"
              >
                <Link href="/contact">Talk to us</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </Section>
    </>
  );
}
