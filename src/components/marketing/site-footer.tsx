import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { Separator } from "@/components/ui/separator";
import { footerNav, siteConfig } from "@/config/site";

export function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t">
      <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 lg:px-8">
        <div className="grid gap-10 md:grid-cols-[1.6fr_repeat(3,1fr)]">
          <div className="max-w-sm">
            <Logo size="md" />
            <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
              {siteConfig.description}
            </p>
            <p className="mt-4 text-sm text-muted-foreground">
              <a
                href={`mailto:${siteConfig.supportEmail}`}
                className="underline-offset-4 transition-colors hover:text-foreground hover:underline"
              >
                {siteConfig.supportEmail}
              </a>
            </p>
          </div>

          {footerNav.map((group) => (
            <nav key={group.title} aria-labelledby={`footer-${group.title}`}>
              <h2
                id={`footer-${group.title}`}
                className="text-sm font-semibold text-foreground"
              >
                {group.title}
              </h2>
              <ul className="mt-4 space-y-3">
                {group.links.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {link.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <Separator className="my-10" />

        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            © {year} {siteConfig.name}. All rights reserved.
          </p>
          {/* Stated plainly rather than buried: overclaiming on tax and audit
              is the failure mode this product most needs to avoid. */}
          <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
            Retail Intelligence AI prepares accounting, GST and tax working
            papers for your review. It does not file returns and does not
            provide legal, tax or audit opinions.
          </p>
        </div>
      </div>
    </footer>
  );
}
