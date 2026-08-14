"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const STATUSES = [
  "",
  "ACTIVE",
  "ONBOARDING",
  "SUSPENDED",
  "CANCELLED",
] as const;

const LABEL: Record<string, string> = {
  "": "All",
  ACTIVE: "Active",
  ONBOARDING: "Onboarding",
  SUSPENDED: "Suspended",
  CANCELLED: "Cancelled",
};

/** Search runs on the server; this only puts the terms in the URL. */
export function TenantSearch({
  query,
  status,
  total,
}: {
  query: string;
  status: string;
  total: number;
}) {
  const router = useRouter();
  const [value, setValue] = React.useState(query);

  function go(next: { q?: string; status?: string }) {
    const params = new URLSearchParams();
    const q = next.q ?? value;
    const s = next.status ?? status;
    if (q) params.set("q", q);
    if (s) params.set("status", s);
    router.push(`/admin/tenants${params.size ? `?${params.toString()}` : ""}`);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <form
        className="flex min-w-56 flex-1 items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          go({});
        }}
      >
        <Input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Search by name"
          aria-label="Search businesses by name"
        />
        <Button type="submit" size="sm" variant="outline">
          <Search className="size-4" />
          Search
        </Button>
      </form>

      <div className="flex flex-wrap gap-1">
        {STATUSES.map((entry) => (
          <Button
            key={entry || "all"}
            size="sm"
            variant={entry === status ? "default" : "ghost"}
            onClick={() => go({ status: entry })}
          >
            {LABEL[entry]}
          </Button>
        ))}
      </div>

      <span className="text-xs text-muted-foreground">
        {total} {total === 1 ? "business" : "businesses"}
      </span>
    </div>
  );
}
