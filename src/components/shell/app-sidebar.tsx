"use client";

import * as React from "react";
import Link from "next/link";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Logo } from "@/components/brand/logo";
import { SidebarNav } from "@/components/shell/sidebar-nav";
import { Button } from "@/components/ui/button";
import { SIDEBAR_COOKIE } from "@/lib/constants/cookies";
import type { NavSection } from "@/lib/navigation";
import { cn } from "@/lib/utils";

/**
 * Desktop sidebar.
 *
 * Collapses to an icon rail, and the choice persists in a cookie the *server*
 * reads before rendering. localStorage would have meant reading it in an
 * effect after mount, which paints the wrong width for a frame and reads to
 * React as a state sync it would rather you avoided. A cookie is available
 * during the server render, so the first paint is already correct.
 */
export function AppSidebar({
  sections,
  includedFeatures,
  defaultCollapsed,
}: {
  sections: NavSection[];
  includedFeatures: string[];
  defaultCollapsed: boolean;
}) {
  const [collapsed, setCollapsed] = React.useState(defaultCollapsed);

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    // A year, path-scoped to the whole app. Not sensitive, so no HttpOnly —
    // and it has to be writable from here without a round trip.
    document.cookie = `${SIDEBAR_COOKIE}=${next ? "1" : "0"}; path=/; max-age=31536000; samesite=lax`;
  }

  return (
    <aside
      data-collapsed={collapsed}
      className={cn(
        "bg-sidebar hidden shrink-0 border-r transition-[width] duration-200 lg:flex lg:flex-col",
        collapsed ? "w-16" : "w-60",
      )}
    >
      <div
        className={cn(
          "flex h-16 shrink-0 items-center border-b",
          collapsed ? "justify-center px-2" : "justify-between px-4",
        )}
      >
        <Link href="/app" aria-label="Retail Intelligence AI dashboard">
          <Logo variant={collapsed ? "mark" : "full"} size="sm" />
        </Link>
        {!collapsed && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggle}
            aria-label="Collapse sidebar"
            className="text-muted-foreground"
          >
            <PanelLeftClose className="size-4" />
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-4">
        <SidebarNav
          sections={sections}
          includedFeatures={includedFeatures}
          collapsed={collapsed}
        />
      </div>

      {collapsed && (
        <div className="flex justify-center border-t p-2">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggle}
            aria-label="Expand sidebar"
            className="text-muted-foreground"
          >
            <PanelLeftOpen className="size-4" />
          </Button>
        </div>
      )}
    </aside>
  );
}
