"use client";

import * as React from "react";
import { Check, X } from "lucide-react";
import { evaluatePasswordStrength } from "@/lib/auth/password-policy";
import { cn } from "@/lib/utils";

/**
 * Password strength meter.
 *
 * The scoring comes from `@/lib/auth/password-policy`, the same module the
 * server enforces with, so this meter cannot disagree with the decision the
 * server is about to make.
 */

const SEGMENT_COLOURS = [
  "bg-destructive",
  "bg-destructive",
  "bg-warning",
  "bg-info",
  "bg-success",
] as const;

export function PasswordStrengthMeter({
  password,
  email,
  name,
  className,
}: {
  password: string;
  email?: string;
  name?: string;
  className?: string;
}) {
  const result = React.useMemo(
    () => evaluatePasswordStrength(password, { email, name }),
    [password, email, name],
  );

  if (!password) return null;

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center gap-2">
        <div className="flex flex-1 gap-1" aria-hidden="true">
          {[0, 1, 2, 3].map((index) => (
            <span
              key={index}
              className={cn(
                "h-1 flex-1 rounded-full transition-colors",
                index < result.score
                  ? SEGMENT_COLOURS[result.score]
                  : "bg-muted",
              )}
            />
          ))}
        </div>
        {/* Announced politely so the rating reaching a screen reader does not
            interrupt the user mid-keystroke. */}
        <span
          className="w-16 shrink-0 text-right text-xs font-medium text-muted-foreground"
          aria-live="polite"
        >
          {result.label}
        </span>
      </div>

      <ul className="space-y-1">
        {result.issues.length > 0 ? (
          result.issues.map((issue) => (
            <li
              key={issue}
              className="flex items-start gap-1.5 text-xs text-muted-foreground"
            >
              <X className="mt-0.5 size-3 shrink-0 text-destructive" />
              {issue}
            </li>
          ))
        ) : (
          <li className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <Check
              className="mt-0.5 size-3 shrink-0 text-success"
              strokeWidth={3}
            />
            Meets the minimum requirements.
          </li>
        )}
      </ul>
    </div>
  );
}
