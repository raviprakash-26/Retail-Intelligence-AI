import Link from "next/link";
import { ArrowLeft, Hammer } from "lucide-react";
import { NavIcon } from "@/components/shell/nav-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * Stands in for a module that is navigable but not yet built.
 *
 * States plainly what is missing and when it arrives. The alternative — a
 * link that 404s, or an empty page that looks like a loading failure — teaches
 * people that parts of the product are broken, which is a much more expensive
 * impression to undo than an honest "not yet".
 */
export function ModulePlaceholder({
  title,
  icon,
  phase,
  description,
  willInclude,
}: {
  title: string;
  icon: string;
  phase: number;
  description: string;
  willInclude: readonly string[];
}) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <Link
        href="/app"
        className="text-muted-foreground hover:text-foreground mb-6 inline-flex items-center gap-1.5 text-sm underline-offset-4 hover:underline"
      >
        <ArrowLeft className="size-3.5" />
        Back to dashboard
      </Link>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="bg-secondary text-secondary-foreground flex size-11 items-center justify-center rounded-xl">
              <NavIcon name={icon} className="size-5" aria-hidden="true" />
            </div>
            <Badge variant="muted" className="gap-1">
              <Hammer className="size-3" />
              Phase {phase}
            </Badge>
          </div>

          <CardTitle className="mt-4 text-xl">{title}</CardTitle>
          <CardDescription className="mt-1.5 leading-relaxed">
            {description}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
          <div>
            <h2 className="text-sm font-semibold">What this will include</h2>
            <ul className="text-muted-foreground mt-2 space-y-1.5 text-sm">
              {willInclude.map((item) => (
                <li key={item} className="flex gap-2">
                  <span className="bg-muted-foreground/40 mt-2 size-1 shrink-0 rounded-full" />
                  {item}
                </li>
              ))}
            </ul>
          </div>

          <div className="bg-muted/50 rounded-lg border p-4">
            <p className="text-sm leading-relaxed">
              This module is not built yet. Nothing here is a mock-up or a
              placeholder figure — when it ships, every number on it will come
              from your own posted transactions.
            </p>
          </div>

          <Button asChild variant="outline">
            <Link href="/app">Back to dashboard</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
