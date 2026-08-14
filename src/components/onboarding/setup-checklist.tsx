import Link from "next/link";
import type { Route } from "next";
import { ArrowRight, Check, Circle, PartyPopper } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import type { OnboardingChecklist } from "@/server/company/onboarding-service";
import { cn } from "@/lib/utils";

/**
 * Setup checklist.
 *
 * Disappears once every required item is done rather than lingering as a
 * permanent "100% complete" trophy — a checklist that never goes away stops
 * being a checklist and starts being furniture.
 */
export function SetupChecklist({
  checklist,
}: {
  checklist: OnboardingChecklist;
}) {
  if (checklist.allRequiredDone) {
    const optionalRemaining = checklist.items.filter(
      (item) => item.optional && !item.done,
    );

    if (optionalRemaining.length === 0) return null;

    return (
      <Card>
        <CardHeader>
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-success-muted text-success">
              <PartyPopper className="size-4" />
            </span>
            <div>
              <CardTitle className="text-base">
                Your setup is complete
              </CardTitle>
              <CardDescription className="mt-1">
                A few optional steps remain if you want them.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <ul className="space-y-2">
            {optionalRemaining.map((item) => (
              <li
                key={item.key}
                className="flex items-center justify-between gap-3"
              >
                <span className="text-sm text-muted-foreground">
                  {item.title}
                </span>
                <Button variant="ghost" size="sm" asChild>
                  <Link href={item.href as Route}>
                    {item.actionLabel}
                    <ArrowRight className="size-3.5" />
                  </Link>
                </Button>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Finish setting up</CardTitle>
            <CardDescription className="mt-1">
              A few steps and your books are ready to use.
            </CardDescription>
          </div>
          <Badge variant="muted" className="tabular-figures">
            {checklist.completed} of {checklist.total}
          </Badge>
        </div>
        <Progress
          value={checklist.percent}
          className="mt-4 h-1.5"
          aria-label={`Setup ${checklist.percent}% complete`}
        />
      </CardHeader>

      <CardContent className="pt-2">
        <ul className="divide-y">
          {checklist.items.map((item) => (
            <li key={item.key} className="flex items-start gap-3 py-3">
              <span
                className={cn(
                  "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full",
                  item.done
                    ? "bg-success text-success-foreground"
                    : "border border-dashed text-muted-foreground",
                )}
                aria-hidden="true"
              >
                {item.done ? (
                  <Check className="size-3" strokeWidth={3} />
                ) : (
                  <Circle className="size-1.5 fill-current" />
                )}
              </span>

              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    "flex flex-wrap items-center gap-2 text-sm font-medium",
                    item.done && "text-muted-foreground line-through",
                  )}
                >
                  {item.title}
                  {item.optional && (
                    <Badge variant="outline" className="font-normal">
                      Optional
                    </Badge>
                  )}
                </p>
                {!item.done && (
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {item.description}
                  </p>
                )}
              </div>

              {!item.done && (
                <Button
                  variant="outline"
                  size="sm"
                  asChild
                  className="shrink-0"
                >
                  <Link href={item.href as Route}>{item.actionLabel}</Link>
                </Button>
              )}

              <span className="sr-only">
                {item.done ? "Completed" : "Not yet done"}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
