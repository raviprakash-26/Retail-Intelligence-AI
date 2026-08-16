"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Building2,
  Calculator,
  CreditCard,
  Download,
  MapPin,
  ScrollText,
  Upload,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Settings navigation.
 *
 * Items the viewer cannot act on are not rendered at all rather than shown
 * disabled — a permanently greyed-out tab tells someone what they are missing
 * without telling them why, which is just a smaller frustration.
 */
const ITEMS = [
  {
    href: "/app/settings/business",
    label: "Business",
    icon: Building2,
    permission: "settings.view",
  },
  {
    href: "/app/settings/accounting",
    label: "Accounting",
    icon: Calculator,
    permission: "settings.view",
  },
  {
    href: "/app/settings/branches",
    label: "Branches",
    icon: MapPin,
    permission: "branches.manage",
  },
  {
    href: "/app/settings/team",
    label: "Team",
    icon: Users,
    permission: "users.view",
  },
  {
    href: "/app/settings/billing",
    label: "Plan",
    icon: CreditCard,
    permission: "billing.view",
  },
  {
    href: "/app/settings/activity",
    label: "Activity",
    icon: ScrollText,
    permission: "auditlog.view",
  },
  {
    href: "/app/settings/data",
    label: "Your data",
    icon: Download,
    permission: "data.export",
  },
  {
    href: "/app/settings/import",
    label: "Bring data in",
    icon: Upload,
    permission: "data.import",
  },
] as const;

export function SettingsNav({ permissions }: { permissions: string[] }) {
  const pathname = usePathname();
  const allowed = new Set(permissions);
  const visible = ITEMS.filter((item) => allowed.has(item.permission));

  return (
    <nav aria-label="Settings sections" className="w-full">
      <ul className="flex gap-1 overflow-x-auto border-b pb-px">
        {visible.map((item) => {
          const active = pathname === item.href;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors",
                  active
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
                )}
              >
                <item.icon className="size-4" aria-hidden="true" />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
