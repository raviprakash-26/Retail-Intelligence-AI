"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { usePathname } from "next/navigation";
import { Menu, Plus } from "lucide-react";
import { Logo } from "@/components/brand/logo";
import { NavIcon } from "@/components/shell/nav-icon";
import { SidebarNav } from "@/components/shell/sidebar-nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  activeHref,
  type NavSection,
  type QuickAction,
} from "@/lib/navigation";
import { cn } from "@/lib/utils";

/**
 * Mobile navigation.
 *
 * A bottom bar with the handful of destinations a person at a counter actually
 * uses, plus a centre button for recording something and a drawer for
 * everything else. A phone-width sidebar is a scroll trap; four thumb-reachable
 * targets are not.
 */
export function MobileNav({
  sections,
  includedFeatures,
  quickActions,
}: {
  sections: NavSection[];
  includedFeatures: string[];
  quickActions: QuickAction[];
}) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [actionsOpen, setActionsOpen] = React.useState(false);

  // Close whatever is open when the route changes; adjusting during render
  // means the new page never paints with a sheet still over it.
  const [lastPath, setLastPath] = React.useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setDrawerOpen(false);
    setActionsOpen(false);
  }

  const primary = sections
    .flatMap((section) => section.items)
    .filter((item) => item.primary)
    .slice(0, 4);

  const current = activeHref(pathname, primary);

  return (
    <>
      {/* Bottom bar. The safe-area inset keeps it clear of the home indicator
          on iOS, where a flush bar is impossible to tap accurately. */}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
      >
        <ul className="grid grid-cols-5 items-center">
          {primary.slice(0, 2).map((item) => (
            <MobileTab
              key={item.href}
              item={item}
              active={current === item.href}
            />
          ))}

          <li className="flex justify-center">
            <Button
              size="icon-lg"
              className="-mt-5 rounded-full shadow-lg"
              onClick={() => setActionsOpen(true)}
              aria-label="Record something"
            >
              <Plus className="size-5" />
            </Button>
          </li>

          {primary.slice(2, 4).map((item) => (
            <MobileTab
              key={item.href}
              item={item}
              active={current === item.href}
            />
          ))}

          {primary.length < 4 && (
            <li>
              <button
                type="button"
                onClick={() => setDrawerOpen(true)}
                className="flex w-full flex-col items-center gap-0.5 py-2.5 text-[0.625rem] font-medium text-muted-foreground"
              >
                <Menu className="size-5" aria-hidden="true" />
                More
              </button>
            </li>
          )}
        </ul>
      </nav>

      {/* Full navigation drawer */}
      <Dialog open={drawerOpen} onOpenChange={setDrawerOpen}>
        <DialogContent className="max-h-[85dvh] max-w-md">
          <DialogHeader>
            <DialogTitle asChild>
              <div>
                <Logo size="sm" />
              </div>
            </DialogTitle>
            <DialogDescription className="sr-only">
              All sections of the application
            </DialogDescription>
          </DialogHeader>
          <div className="overflow-y-auto">
            <SidebarNav
              sections={sections}
              includedFeatures={includedFeatures}
              onNavigate={() => setDrawerOpen(false)}
            />
          </div>
        </DialogContent>
      </Dialog>

      {/* Quick actions */}
      <Dialog open={actionsOpen} onOpenChange={setActionsOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Record something</DialogTitle>
            <DialogDescription>
              Everything else follows from the entry — accounting, stock and
              tax.
            </DialogDescription>
          </DialogHeader>

          <ul className="grid grid-cols-2 gap-2">
            {quickActions.map((action) => {
              const notBuilt = action.status === "planned";
              return (
                <li key={action.href}>
                  <Link
                    href={action.href as Route}
                    onClick={() => setActionsOpen(false)}
                    className={cn(
                      "flex flex-col gap-1.5 rounded-lg border p-3 transition-colors hover:bg-secondary",
                      notBuilt && "opacity-60",
                    )}
                  >
                    <NavIcon
                      name={action.icon}
                      className="size-4 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="text-xs font-medium">{action.label}</span>
                    {notBuilt && (
                      <Badge
                        variant="muted"
                        className="w-fit px-1 py-0 text-[0.5625rem]"
                      >
                        Soon
                      </Badge>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </DialogContent>
      </Dialog>

      {/* Reserves room so the bottom bar never covers the end of a page. */}
      <div className="h-16 lg:hidden" aria-hidden="true" />
    </>
  );
}

function MobileTab({
  item,
  active,
}: {
  item: NavSection["items"][number];
  active: boolean;
}) {
  return (
    <li>
      <Link
        href={item.href as Route}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex flex-col items-center gap-0.5 py-2.5 text-[0.625rem] font-medium transition-colors",
          active ? "text-primary" : "text-muted-foreground",
        )}
      >
        <NavIcon name={item.icon} className="size-5" aria-hidden="true" />
        <span className="truncate px-1">{item.label}</span>
      </Link>
    </li>
  );
}
