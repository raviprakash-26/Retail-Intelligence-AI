import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export type RegisterStep = {
  id: number;
  title: string;
  description: string;
};

export const REGISTER_STEPS: readonly RegisterStep[] = [
  { id: 1, title: "Your details", description: "How you sign in" },
  { id: 2, title: "Your business", description: "Name, GST and address" },
  { id: 3, title: "Your books", description: "Financial year and openings" },
] as const;

export function RegisterStepper({ current }: { current: number }) {
  return (
    <nav aria-label="Registration progress">
      <ol className="flex items-center gap-2">
        {REGISTER_STEPS.map((step, index) => {
          const complete = step.id < current;
          const active = step.id === current;

          return (
            <li key={step.id} className="flex flex-1 items-center gap-2">
              <div className="flex min-w-0 items-center gap-2.5">
                <span
                  className={cn(
                    "tabular-figures flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors",
                    complete &&
                      "border-success bg-success text-success-foreground",
                    active &&
                      "border-primary bg-primary text-primary-foreground",
                    !complete &&
                      !active &&
                      "border-border text-muted-foreground",
                  )}
                  aria-hidden="true"
                >
                  {complete ? (
                    <Check className="size-3.5" strokeWidth={3} />
                  ) : (
                    step.id
                  )}
                </span>
                <span className="hidden min-w-0 sm:block">
                  <span
                    className={cn(
                      "block truncate text-xs font-medium",
                      active ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {step.title}
                  </span>
                </span>
              </div>

              {index < REGISTER_STEPS.length - 1 && (
                <span
                  className={cn(
                    "h-px flex-1 transition-colors",
                    complete ? "bg-success" : "bg-border",
                  )}
                  aria-hidden="true"
                />
              )}

              <span className="sr-only">
                {`Step ${step.id} of ${REGISTER_STEPS.length}: ${step.title}. ${
                  complete
                    ? "Completed."
                    : active
                      ? "Current step."
                      : "Not started."
                }`}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
