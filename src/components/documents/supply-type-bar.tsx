"use client";

import type { Control, FieldValues, Path } from "react-hook-form";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { FormControl, FormField, FormItem } from "@/components/ui/form";
import { Label } from "@/components/ui/label";
import { findStateByCode } from "@/lib/constants/india";
import {
  chargesTax,
  describeSupplyType,
  type GstRegistration,
  type SupplyType,
} from "@/lib/tax/gst";

/**
 * States the tax treatment before a single line is entered.
 *
 * A retailer who cannot see whether a document is CGST + SGST or IGST until
 * after it is posted finds out from the return. Showing it up front, with the
 * place of supply that decided it, makes a wrong customer state obvious while
 * it is still cheap to fix — and when no tax applies at all, it says why rather
 * than leaving a blank where the GST should be.
 */
export function SupplyTypeBar<TValues extends FieldValues>({
  supplyType,
  registration,
  placeOfSupply,
  counterpartyLabel,
  control,
  inclusiveName,
  inclusiveLabel,
}: {
  supplyType: SupplyType;
  registration: GstRegistration;
  placeOfSupply: string | null;
  /** "you supply from Karnataka", "billed from Maharashtra". */
  counterpartyLabel: string | null;
  control: Control<TValues>;
  inclusiveName: Path<TValues>;
  inclusiveLabel: string;
}) {
  const notice = describeSupplyType(supplyType, registration);
  const stateName = placeOfSupply
    ? (findStateByCode(placeOfSupply)?.name ?? placeOfSupply)
    : "—";

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border bg-muted/30 px-4 py-3 text-sm">
      <span className="flex items-center gap-2">
        <Badge variant={supplyType === "INTER_STATE" ? "info" : "muted"}>
          {supplyType === "INTRA_STATE"
            ? "CGST + SGST"
            : supplyType === "INTER_STATE"
              ? "IGST"
              : "No GST"}
        </Badge>
        <span className="text-muted-foreground">
          {chargesTax(supplyType)
            ? `Place of supply ${stateName}${counterpartyLabel ? ` · ${counterpartyLabel}` : ""}`
            : (notice ?? "")}
        </span>
      </span>

      <FormField
        control={control}
        name={inclusiveName}
        render={({ field }) => (
          <FormItem className="ml-auto flex flex-row items-center gap-2">
            <FormControl>
              <Checkbox
                id={String(inclusiveName)}
                checked={Boolean(field.value)}
                onCheckedChange={field.onChange}
              />
            </FormControl>
            <Label htmlFor={String(inclusiveName)} className="font-normal">
              {inclusiveLabel}
            </Label>
          </FormItem>
        )}
      />
    </div>
  );
}
