"use client";

import Link from "next/link";
import type { Route } from "next";
import { ChevronDown, Plus } from "lucide-react";
import { NavIcon } from "@/components/shell/nav-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { QuickAction } from "@/lib/navigation";

/**
 * The "New" menu.
 *
 * Desktop only — on a phone the same actions live behind the centre button of
 * the bottom bar, which is far easier to reach with a thumb.
 */
export function QuickActionsMenu({ actions }: { actions: QuickAction[] }) {
  if (actions.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" className="hidden gap-1.5 sm:inline-flex">
          <Plus className="size-4" />
          New
          <ChevronDown className="size-3.5 opacity-70" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Record something</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {actions.map((action) => {
          const notBuilt = action.status === "planned";
          return (
            <DropdownMenuItem key={action.href} asChild>
              <Link href={action.href as Route} className="gap-2">
                <NavIcon name={action.icon} className="size-4" />
                <span className={notBuilt ? "text-muted-foreground" : undefined}>
                  {action.label}
                </span>
                {notBuilt && (
                  <Badge
                    variant="muted"
                    className="ml-auto px-1 py-0 text-[0.5625rem] font-normal"
                  >
                    Soon
                  </Badge>
                )}
              </Link>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
