"use client";

import * as React from "react";
import type { PartyType } from "@prisma/client";
import { Check, ChevronsUpDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * Picks an account for a journal line.
 *
 * The whole list arrives with the page rather than being searched on the
 * server: a chart of accounts is a few dozen rows, it is the same for everyone
 * in the business, and nothing in it is a secret from someone already allowed
 * to post entries. Searching over it in the browser is instant, which matters
 * when an accountant is entering six lines in a row.
 *
 * Codes are shown beside names because that is how accountants navigate a
 * chart, and because two accounts can reasonably share a name across types.
 */

export type PickerAccount = {
  id: string;
  code: string;
  name: string;
  groupName: string;
  /** Set on a control account, which needs a name against every line. */
  partyType: PartyType | null;
};

export function AccountPicker({
  value,
  accounts,
  onSelect,
  name,
}: {
  value: PickerAccount | null;
  accounts: PickerAccount[];
  onSelect: (account: PickerAccount) => void;
  /** Applied to the trigger so a form test can target the row. */
  name?: string;
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          name={name}
          className={cn(
            "h-9 w-full justify-between font-normal",
            !value && "text-muted-foreground",
          )}
        >
          <span className="truncate">
            {value ? (
              <>
                <span className="mr-1.5 font-mono text-xs text-muted-foreground">
                  {value.code}
                </span>
                {value.name}
              </>
            ) : (
              "Choose an account"
            )}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        className="w-[min(28rem,calc(100vw-2rem))] p-0"
      >
        <Command
          filter={(itemValue, search) =>
            itemValue.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
          }
        >
          <CommandInput placeholder="Search by name or code" />
          <CommandList>
            <CommandEmpty>No account matches.</CommandEmpty>
            {accounts.map((account) => (
              <CommandItem
                key={account.id}
                value={`${account.code} ${account.name} ${account.groupName}`}
                onSelect={() => {
                  onSelect(account);
                  setOpen(false);
                }}
                className="gap-2"
              >
                <Check
                  className={cn(
                    "size-3.5 shrink-0",
                    value?.id === account.id ? "opacity-100" : "opacity-0",
                  )}
                />
                <span className="w-12 shrink-0 font-mono text-xs text-muted-foreground">
                  {account.code}
                </span>
                <span className="min-w-0 flex-1 truncate">{account.name}</span>
                {account.partyType && (
                  <Badge variant="outline" className="shrink-0 text-[0.625rem]">
                    needs a name
                  </Badge>
                )}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
