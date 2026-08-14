import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { getFeatureIcon } from "@/components/marketing/feature-icon";
import { Section, SectionHeading } from "@/components/marketing/section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { features } from "@/config/site";

export const metadata: Metadata = {
  title: "Features",
  description:
    "Double-entry accounting, inventory, GST preparation, analytics, forecasting and AI assistance — built around a single accounting engine.",
};

const CATEGORIES = [
  {
    key: "accounting" as const,
    title: "Accounting",
    description:
      "The core ledger. Every other number in the product is derived from it.",
  },
  {
    key: "operations" as const,
    title: "Operations",
    description:
      "The day-to-day records — stock, customers and suppliers — that feed the ledger.",
  },
  {
    key: "compliance" as const,
    title: "Compliance",
    description:
      "GST and tax working papers, prepared for your review. Nothing is filed on your behalf.",
  },
  {
    key: "intelligence" as const,
    title: "Intelligence",
    description:
      "Analysis and explanation layered on top of figures the system calculated deterministically.",
  },
];

/** Modules that ship in later phases, listed so the roadmap is not implied. */
const MODULE_MATRIX = [
  {
    module: "Sales & sales returns",
    detail: "Invoicing, payment modes, customer outstanding",
  },
  {
    module: "Purchases & purchase returns",
    detail: "Supplier bills, credit periods, input tax",
  },
  {
    module: "Expenses",
    detail: "Categorised, with revenue vs capital treatment",
  },
  {
    module: "Receipts & payments",
    detail: "Allocation against specific invoices and bills",
  },
  {
    module: "Journal",
    detail: "Full voucher listing with filters and drill-through",
  },
  { module: "Ledger", detail: "Per-account statement with running balance" },
  {
    module: "Trial balance",
    detail: "Validated before any statement is produced",
  },
  {
    module: "Trading account",
    detail: "Opening stock through to gross profit",
  },
  { module: "Profit & loss", detail: "Gross profit through to net profit" },
  { module: "Balance sheet", detail: "Assets, liabilities and equity" },
  {
    module: "Cash flow statement",
    detail: "Operating, investing and financing activities",
  },
  {
    module: "Receipts & payments account",
    detail: "Formal cash summary with opening and closing",
  },
  {
    module: "Income & expenditure",
    detail: "Revenue and capital items kept distinct",
  },
  {
    module: "Ratio analysis",
    detail: "Eleven ratios with formula, trend and interpretation",
  },
  {
    module: "Inventory",
    detail: "Movement history, valuation and low-stock alerts",
  },
  {
    module: "Employees & payroll",
    detail: "Salary runs posted through the accounting engine",
  },
  {
    module: "GST registers",
    detail: "Sales, purchase, input, output and reconciliation",
  },
  {
    module: "Financial health score",
    detail: "Composite of profitability, liquidity and growth",
  },
] as const;

export default function FeaturesPage() {
  return (
    <>
      <Section className="pb-10">
        <SectionHeading
          eyebrow="Features"
          title="One system of record, and everything that follows from it."
          description="Retail Intelligence AI is not a collection of separate tools sharing a login. Sales, stock, tax and reporting are different views of the same posted transactions."
        />
      </Section>

      {CATEGORIES.map((category, index) => {
        const items = features.filter((f) => f.category === category.key);
        return (
          <Section
            key={category.key}
            className={index % 2 === 1 ? "border-y bg-muted/40" : ""}
          >
            <SectionHeading
              align="left"
              title={category.title}
              description={category.description}
            />
            <div className="mt-10 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
              {items.map((feature) => {
                const Icon = getFeatureIcon(feature.icon);
                return (
                  <Card key={feature.title} className="card-hover">
                    <CardHeader>
                      <div className="flex size-10 items-center justify-center rounded-lg bg-primary-muted text-primary">
                        <Icon className="size-5" aria-hidden="true" />
                      </div>
                      <CardTitle className="mt-3.5 flex flex-wrap items-center gap-2 text-base">
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
        );
      })}

      <Section>
        <SectionHeading
          eyebrow="Modules"
          title="What is in the product"
          description="Every module below writes to, or reads from, the same double-entry ledger."
        />

        <div className="mt-12 grid gap-x-8 gap-y-0 sm:grid-cols-2">
          {MODULE_MATRIX.map((row) => (
            <div
              key={row.module}
              className="flex items-baseline justify-between gap-4 border-b py-3.5"
            >
              <span className="flex items-baseline gap-2.5 text-sm font-medium">
                <Check
                  className="size-3.5 shrink-0 translate-y-0.5 text-success"
                  strokeWidth={3}
                />
                {row.module}
              </span>
              <span className="text-right text-xs text-muted-foreground">
                {row.detail}
              </span>
            </div>
          ))}
        </div>
      </Section>

      <Section className="pt-0">
        <Card>
          <CardContent className="flex flex-col items-center gap-5 py-12 text-center">
            <h2 className="text-2xl font-semibold tracking-tight text-balance">
              See it working on your own numbers.
            </h2>
            <p className="max-w-lg leading-relaxed text-muted-foreground">
              Create a business, record a few transactions, and check the trial
              balance yourself.
            </p>
            <Button size="lg" asChild>
              <Link href="/register">
                Start free
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      </Section>
    </>
  );
}
