"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2, LayoutDashboard, ScrollText, Tags } from "lucide-react";
import { cn } from "@/lib/utils";

type AdminNavItem = {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** Overview lives at the root, so without this it matches every admin page. */
  exact?: boolean;
};

const ITEMS: readonly AdminNavItem[] = [
  { href: "/admin", label: "Overview", icon: LayoutDashboard, exact: true },
  { href: "/admin/tenants", label: "Businesses", icon: Building2 },
  { href: "/admin/plans", label: "Plans", icon: Tags },
  { href: "/admin/activity", label: "Admin activity", icon: ScrollText },
];

export function AdminNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Administration sections">
      <ul className="flex gap-1 overflow-x-auto border-b pb-px">
        {ITEMS.map((item) => {
          const active = item.exact
            ? pathname === item.href
            : pathname.startsWith(item.href);
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
