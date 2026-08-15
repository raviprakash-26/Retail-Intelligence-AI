import { CircleHelp } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * A single headline figure.
 *
 * `pending` is a first-class state rather than a zero. A KPI that shows ₹0
 * because its module has not been built yet is indistinguishable from a
 * business that genuinely earned nothing — and on a financial dashboard that
 * is not a cosmetic difference.
 */
export function KpiCard({
  label,
  value,
  hint,
  pending,
  pendingNote,
  className,
}: {
  label: string;
  value?: string;
  hint?: string;
  pending?: boolean;
  pendingNote?: string;
  className?: string;
}) {
  return (
    <Card className={cn("gap-0", className)}>
      <CardContent className="px-4 py-4">
        <div className="flex items-center gap-1.5">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          {hint && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={`About ${label}`}
                >
                  <CircleHelp className="size-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{hint}</TooltipContent>
            </Tooltip>
          )}
        </div>

        {pending ? (
          <>
            <Skeleton className="mt-2 h-6 w-24" />
            <p className="mt-2 text-[0.6875rem] leading-relaxed text-muted-foreground">
              {pendingNote ?? "Available once this module is built."}
            </p>
          </>
        ) : (
          <p className="tabular-figures mt-1.5 text-xl font-semibold tracking-tight">
            {value}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
