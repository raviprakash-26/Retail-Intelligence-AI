"use client";

import Link from "next/link";
import type { Route } from "next";
import { usePathname } from "next/navigation";
import { Lock, Sparkles } from "lucide-react";
import { NavIcon } from "@/components/shell/nav-icon";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { activeHref, type NavSection } from "@/lib/navigation";
import { cn } from "@/lib/utils";

export type SidebarNavProps = {
  sections: NavSection[];
  /** Features the subscription includes, for the plan gate. */
  includedFeatures: string[];
  /** Collapsed rail: icons only, labels in tooltips. */
  collapsed?: boolean;
  onNavigate?: () => void;
};

export function SidebarNav({
  sections,
  includedFeatures,
  collapsed = false,
  onNavigate,
}: SidebarNavProps) {
  const pathname = usePathname();
  const included = new Set(includedFeatures);

  const allHrefs = sections.flatMap((section) =>
    section.items.map((item) => item.href),
  );
  const current = activeHref(pathname, allHrefs);

  return (
    <TooltipProvider delayDuration={0}>
      <nav aria-label="Main navigation" className="flex flex-col gap-6">
        {sections.map((section) => (
          <div key={section.label}>
            {!collapsed && (
              <h2 className="px-3 pb-2 text-[0.6875rem] font-semibold tracking-wider text-muted-foreground uppercase">
                {section.label}
              </h2>
            )}

            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const isActive = current === item.href;
                const planGated = Boolean(item.feature && !included.has(item.feature));
                const notBuilt = item.status === "planned";

                const link = (
                  <Link
                    href={item.href as Route}
                    onClick={onNavigate}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                      collapsed && "justify-center px-0",
                      isActive
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                      // A muted item reads as "not yet" rather than "broken",
                      // which is what a normal-looking dead link would suggest.
                      (notBuilt || planGated) && !isActive && "text-sidebar-foreground/45",
                    )}
                  >
                    <NavIcon name={item.icon} className="size-4 shrink-0" aria-hidden="true" />
                    {!collapsed && (
                      <>
                        <span className="truncate">{item.label}</span>
                        <span className="ml-auto flex shrink-0 items-center gap-1">
                          {planGated && (
                            <Sparkles
                              className="size-3 text-muted-foreground"
                              aria-label="Included in a higher plan"
                            />
                          )}
                          {notBuilt && (
                            <Badge
                              variant="muted"
                              className="px-1 py-0 text-[0.5625rem] font-normal"
                            >
                              Soon
                            </Badge>
                          )}
                        </span>
                      </>
                    )}
                  </Link>
                );

                return (
                  <li key={item.href}>
                    {collapsed ? (
                      <Tooltip>
                        <TooltipTrigger asChild>{link}</TooltipTrigger>
                        <TooltipContent side="right" className="flex items-center gap-1.5">
                          {item.label}
                          {notBuilt && <span className="opacity-70">· soon</span>}
                          {planGated && <Lock className="size-3" />}
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      link
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </TooltipProvider>
  );
}
