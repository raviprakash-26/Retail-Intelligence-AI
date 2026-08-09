import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Section, SectionHeading } from "@/components/marketing/section";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { siteConfig } from "@/config/site";

export const metadata: Metadata = {
  title: "About",
  description:
    "Why Retail Intelligence AI exists, and the principles the product is built on.",
};

const PRINCIPLES = [
  {
    title: "Correctness before appearance",
    body: "A dashboard that looks confident and reports the wrong profit is worse than no dashboard. Where a figure cannot be computed reliably, the product says so rather than showing a number that looks authoritative.",
  },
  {
    title: "Deterministic where it matters",
    body: "Profit, tax, balances, statements and ratios are calculated by code with exact decimal arithmetic. AI is used for explanation, anomaly detection and natural-language questions — never to produce a financial figure.",
  },
  {
    title: "No overclaiming",
    body: "The product prepares GST and tax working papers. It does not file returns, and it does not present its output as professional tax, legal or audit advice. Anything marked as an estimate is labelled as one.",
  },
  {
    title: "Your data is yours",
    body: "Every report exports to PDF, Excel and CSV. Leaving should be as easy as arriving — that is a product constraint, not a concession.",
  },
  {
    title: "Auditable by construction",
    body: "Posted transactions are immutable. Corrections are reversals with reasons. The activity log is append-only. When someone asks how a number came to be, there is an answer.",
  },
  {
    title: "Built for the person at the counter",
    body: "The primary user is a shop owner with a business to run, not an accountant. Accounting vocabulary is available when wanted and out of the way when not.",
  },
];

export default function AboutPage() {
  return (
    <>
      <Section className="pb-8">
        <SectionHeading
          eyebrow="About"
          title="Small retailers deserve the same financial clarity that large ones buy."
          description="A shop turning over a few lakh a month faces the same questions as a company turning over crores — what did I earn, what do I owe, what can I afford. It just cannot afford a finance team to answer them."
        />
      </Section>

      <Section className="py-0">
        <div className="prose-none mx-auto max-w-2xl space-y-5 text-base leading-relaxed">
          <p className="text-muted-foreground">
            Most accounting software is built for accountants. It assumes you
            know what a contra entry is, that you will remember to update stock
            separately from sales, and that someone will reconcile it all at
            year end. For a retail business, that assumption fails on day one.
          </p>
          <p className="text-muted-foreground">
            The alternative most shops land on is a notebook and a spreadsheet.
            That works until it does not — until GST is due, or a supplier
            disputes a balance, or a bank wants to see three years of accounts,
            or the owner simply wants to know which of their products actually
            makes money.
          </p>
          <p className="text-muted-foreground">
            {siteConfig.name} takes a different position: the retailer records
            what happened in plain language, once, and the software takes
            responsibility for everything that follows — the double entry, the
            stock movement, the tax treatment, the statements, and the analysis
            on top of them.
          </p>
          <p className="text-muted-foreground">
            That only works if the accounting underneath is genuinely correct.
            So the ledger came first, and the interface was built on top of it —
            not the other way round.
          </p>
        </div>
      </Section>

      <Section>
        <SectionHeading
          eyebrow="Principles"
          title="What we hold to"
          description="These are constraints on how the product is built, not marketing copy. Where they conflict with a nicer-looking feature, they win."
        />

        <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {PRINCIPLES.map((principle) => (
            <Card key={principle.title} className="card-hover">
              <CardHeader>
                <CardTitle className="text-base">{principle.title}</CardTitle>
                <CardDescription className="mt-2 leading-relaxed">
                  {principle.body}
                </CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </Section>

      <Section className="border-t bg-muted/40">
        <Card>
          <CardContent className="flex flex-col items-center gap-5 py-12 text-center">
            <h2 className="text-2xl font-semibold tracking-tight text-balance">
              Have a question we have not answered?
            </h2>
            <p className="max-w-lg leading-relaxed text-muted-foreground">
              We would rather have the conversation than have you guess.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button size="lg" asChild>
                <Link href="/contact">
                  Contact us
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <Link href="/register">Start free</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </Section>
    </>
  );
}
