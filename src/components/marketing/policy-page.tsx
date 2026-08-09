import { FileText } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export type PolicySection = {
  heading: string;
  paragraphs?: readonly string[];
  bullets?: readonly string[];
};

/**
 * Shared shell for the policy pages.
 *
 * These pages describe how the software actually behaves — what it stores,
 * where, for how long, and who can reach it. They are written as an accurate
 * technical description and are explicitly marked as requiring legal review
 * before they are relied on as a contract, because presenting an unreviewed
 * document as binding terms would be worse than presenting nothing.
 */
export function PolicyPage({
  title,
  summary,
  updatedAt,
  sections,
}: {
  title: string;
  summary: string;
  updatedAt: string;
  sections: readonly PolicySection[];
}) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-20 sm:px-6 lg:px-8">
      <header className="space-y-4">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          {title}
        </h1>
        <p className="leading-relaxed text-pretty text-muted-foreground">
          {summary}
        </p>
        <p className="text-sm text-muted-foreground">
          Last updated {updatedAt}
        </p>
      </header>

      <Alert variant="warning" className="mt-8">
        <FileText />
        <AlertTitle>Draft pending legal review</AlertTitle>
        <AlertDescription>
          <p>
            This document accurately describes how the software is built and
            operated, but it has not yet been reviewed by counsel and is not a
            binding agreement. It will be replaced with a reviewed version
            before general availability.
          </p>
        </AlertDescription>
      </Alert>

      <div className="mt-12 space-y-10">
        {sections.map((section) => (
          <section key={section.heading} className="space-y-3">
            <h2 className="text-lg font-semibold tracking-tight">
              {section.heading}
            </h2>
            {section.paragraphs?.map((paragraph) => (
              <p
                key={paragraph.slice(0, 40)}
                className="leading-relaxed text-muted-foreground"
              >
                {paragraph}
              </p>
            ))}
            {section.bullets && (
              <ul className="list-disc space-y-2 pl-5 leading-relaxed text-muted-foreground">
                {section.bullets.map((bullet) => (
                  <li key={bullet.slice(0, 40)}>{bullet}</li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
