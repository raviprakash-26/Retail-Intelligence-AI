import Link from "next/link";
import { Quote, ShieldCheck } from "lucide-react";
import { Logo } from "@/components/brand/logo";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { trustPoints } from "@/config/site";

/**
 * Split layout for the authentication routes.
 *
 * The form sits on the left at a comfortable reading width; the right panel
 * carries the brand and a short reassurance. On small screens the panel is
 * dropped entirely rather than stacked — on a phone, a person trying to sign
 * in wants the form, not a value proposition.
 */
export default function AuthLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1fr_minmax(0,32rem)] xl:grid-cols-[1fr_minmax(0,36rem)]">
      {/* Form column */}
      <div className="flex flex-col">
        <header className="flex items-center justify-between px-6 py-6 sm:px-10">
          <Link
            href="/"
            className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-4"
          >
            <Logo size="md" />
          </Link>
          <ThemeToggle />
        </header>

        <main className="flex flex-1 items-start justify-center px-6 pt-4 pb-16 sm:px-10">
          <div className="w-full max-w-md">{children}</div>
        </main>

        <footer className="px-6 pb-6 text-xs text-muted-foreground sm:px-10">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Link
              href="/privacy"
              className="transition-colors hover:text-foreground"
            >
              Privacy
            </Link>
            <Link
              href="/terms"
              className="transition-colors hover:text-foreground"
            >
              Terms
            </Link>
            <Link
              href="/contact"
              className="transition-colors hover:text-foreground"
            >
              Support
            </Link>
          </div>
        </footer>
      </div>

      {/* Brand panel */}
      <aside className="relative hidden overflow-hidden bg-primary text-primary-foreground lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.14]"
          aria-hidden="true"
          style={{
            backgroundImage:
              "radial-gradient(circle at 20% 15%, white 0%, transparent 45%), radial-gradient(circle at 85% 75%, white 0%, transparent 40%)",
          }}
        />

        <div className="relative">
          <div className="inline-flex items-center gap-2 rounded-full border border-primary-foreground/20 bg-primary-foreground/10 px-3 py-1 text-xs">
            <ShieldCheck className="size-3.5" />
            Built on a real double-entry ledger
          </div>
        </div>

        <div className="relative max-w-md">
          <Quote
            className="size-8 text-primary-foreground/30"
            aria-hidden="true"
          />
          <p className="mt-5 text-xl leading-relaxed font-medium text-balance">
            Record what happened once. Your accounts, statements, GST working
            and insights follow from it automatically.
          </p>

          <ul className="mt-10 space-y-4 border-t border-primary-foreground/15 pt-8">
            {trustPoints.map((point) => (
              <li key={point.title}>
                <p className="text-sm font-semibold">{point.title}</p>
                <p className="mt-0.5 text-sm leading-relaxed text-primary-foreground/70">
                  {point.description}
                </p>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs text-primary-foreground/60">
          Retail Intelligence AI prepares working papers for your review. It
          does not file returns or provide tax or audit opinions.
        </p>
      </aside>
    </div>
  );
}
