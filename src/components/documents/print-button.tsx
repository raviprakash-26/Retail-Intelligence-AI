"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Print, which is also how a browser saves a PDF.
 *
 * No PDF library. Every browser prints to PDF, the result honours the print
 * stylesheet already in this application, and a generated PDF would be a second
 * layout to keep in step with the first — which is how the paper copy and the
 * screen end up disagreeing.
 */
export function PrintButton({ label = "Print" }: { label?: string }) {
  return (
    <Button type="button" variant="outline" onClick={() => window.print()}>
      <Printer aria-hidden="true" />
      {label}
    </Button>
  );
}
