"use client";

import * as React from "react";
import { Building2, Check, ChevronsUpDown } from "lucide-react";
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
import { switchCompanyAction } from "@/server/company/actions";

export type CompanyOption = {
  id: string;
  name: string;
  roleName: string;
  isDemo: boolean;
};

/**
 * Business switcher.
 *
 * Rendered only when the user belongs to more than one business — a dropdown
 * with a single option is a control that does nothing.
 */
export function CompanySwitcher({
  companies,
  currentCompanyId,
}: {
  companies: CompanyOption[];
  currentCompanyId: string;
}) {
  const [pending, setPending] = React.useState<string | null>(null);
  const current = companies.find((company) => company.id === currentCompanyId);

  if (companies.length <= 1) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="max-w-56 justify-between"
        >
          <span className="flex min-w-0 items-center gap-2">
            <Building2 className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">
              {current?.name ?? "Select business"}
            </span>
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="min-w-64">
        <DropdownMenuLabel>Your businesses</DropdownMenuLabel>
        <DropdownMenuSeparator />

        {companies.map((company) => (
          <DropdownMenuItem
            key={company.id}
            disabled={pending !== null}
            onClick={() => {
              if (company.id === currentCompanyId) return;
              setPending(company.id);
              // A server action that redirects; the page reloads into the new
              // tenant, so no client-side state needs clearing.
              void switchCompanyAction(company.id);
            }}
            className="gap-2"
          >
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                {company.name}
                {company.isDemo && (
                  <Badge variant="warning" className="text-[0.625rem]">
                    Demo
                  </Badge>
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {company.roleName}
              </p>
            </div>
            {company.id === currentCompanyId && (
              <Check className="size-4 shrink-0 text-primary" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
