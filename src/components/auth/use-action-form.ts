"use client";

import * as React from "react";
import type { FieldValues, Path, UseFormReturn } from "react-hook-form";
import type { ActionResult } from "@/server/auth/action-result";

/**
 * Applies a server action's result to a react-hook-form instance.
 *
 * The server is the authority on validation, so its field errors have to reach
 * the same inputs the client-side resolver writes to. Keeping that mapping in
 * one place means a new form cannot quietly drop server errors on the floor
 * and leave the user staring at a form that "looks fine" but will not submit.
 */
export function useServerFormErrors<TValues extends FieldValues>(
  form: UseFormReturn<TValues, unknown, TValues>,
) {
  const [formError, setFormError] = React.useState<string | null>(null);
  const [retryAfterSeconds, setRetryAfterSeconds] = React.useState<
    number | null
  >(null);

  const reset = React.useCallback(() => {
    setFormError(null);
    setRetryAfterSeconds(null);
  }, []);

  const applyResult = React.useCallback(
    <T>(result: ActionResult<T>): result is { ok: true; data: T } => {
      if (result.ok) {
        reset();
        return true;
      }

      setFormError(result.message);
      setRetryAfterSeconds(result.retryAfterSeconds ?? null);

      if (result.fieldErrors) {
        let focused = false;
        for (const [field, message] of Object.entries(result.fieldErrors)) {
          form.setError(field as Path<TValues>, { type: "server", message });
          if (!focused) {
            // Move focus to the first offending input so a keyboard or screen
            // reader user is taken to the problem rather than left at the
            // submit button.
            form.setFocus(field as Path<TValues>);
            focused = true;
          }
        }
      }

      return false;
    },
    [form, reset],
  );

  return { formError, retryAfterSeconds, applyResult, reset, setFormError };
}
