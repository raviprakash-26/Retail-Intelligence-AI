import { SiteFooter } from "@/components/marketing/site-footer";
import { SiteHeader } from "@/components/marketing/site-header";

export default function MarketingLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-dvh flex-col">
      {/* Keyboard users should not have to tab through the whole nav on
          every page to reach the content. */}
      <a
        href="#main"
        className="sr-only-focusable fixed top-4 left-4 z-[100] rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
      >
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
