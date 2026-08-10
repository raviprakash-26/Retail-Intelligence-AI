"use client";

import Link from "next/link";
import {
  BadgeCheck,
  CircleHelp,
  LogOut,
  MailWarning,
  Settings,
} from "lucide-react";
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
import { initialsOf } from "@/lib/format";
import { signOutAction } from "@/server/auth/actions";

export function UserMenu({
  fullName,
  email,
  roleName,
  emailVerified,
  canViewSettings,
}: {
  fullName: string;
  email: string;
  roleName: string;
  emailVerified: boolean;
  canViewSettings: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full"
          aria-label={`Account menu for ${fullName}`}
        >
          <span className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-full text-xs font-semibold">
            {initialsOf(fullName)}
          </span>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="font-normal">
          <p className="text-sm font-medium">{fullName}</p>
          <p className="text-muted-foreground truncate text-xs">{email}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge variant="muted">{roleName}</Badge>
            {emailVerified ? (
              <Badge variant="success">
                <BadgeCheck className="size-3" />
                Verified
              </Badge>
            ) : (
              <Badge variant="warning">
                <MailWarning className="size-3" />
                Unconfirmed
              </Badge>
            )}
          </div>
        </DropdownMenuLabel>

        <DropdownMenuSeparator />

        {canViewSettings && (
          <DropdownMenuItem asChild>
            <Link href="/app/settings/business">
              <Settings className="size-4" />
              Business settings
            </Link>
          </DropdownMenuItem>
        )}

        <DropdownMenuItem asChild>
          <Link href="/contact">
            <CircleHelp className="size-4" />
            Help and support
          </Link>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {/* A form post rather than an onClick: signing out must work even if
            the page's JavaScript failed to load. */}
        <form action={signOutAction}>
          <button
            type="submit"
            className="focus:bg-secondary text-destructive relative flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none"
          >
            <LogOut className="text-destructive size-4" />
            Sign out
          </button>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
