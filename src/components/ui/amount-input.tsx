"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Numeric input that hands the form a `number` rather than a string.
 *
 * A native number input yields `""` while empty and `NaN` while
 * half-typed ("1e", "-"). Passing either straight into a form field produces a
 * validation error the user cannot act on, so both are normalised to the
 * supplied `emptyValue`.
 *
 * The visible text is kept as local state so a user can clear the field and
 * type a new figure without it snapping back to 0 on each keystroke.
 */
export type AmountInputProps = Omit<
  React.ComponentProps<typeof Input>,
  "type" | "value" | "onChange"
> & {
  value: number;
  onChange: (value: number) => void;
  emptyValue?: number;
  /** Renders a currency symbol inside the field. */
  prefix?: string;
};

export function AmountInput({
  value,
  onChange,
  onBlur,
  emptyValue = 0,
  prefix,
  className,
  ...props
}: AmountInputProps) {
  const [text, setText] = React.useState(() => String(value ?? emptyValue));

  // Re-sync when the form resets or sets the value programmatically. The
  // numeric comparison means a value we ourselves just pushed upward does not
  // bounce back and clobber what the user is typing ("12." stays "12." even
  // though it parses to the 12 already in the form).
  //
  React.useEffect(() => {
    const parsed = Number.parseFloat(text);
    if (Number.isNaN(parsed) ? value !== emptyValue : parsed !== value) {
      // The compiler lint flags setState-in-effect as a cascading-render risk.
      // That is the correct shape here: this is a controlled input
      // synchronising with an external store (react-hook-form), the guard above
      // makes the update a no-op in the common case, and the alternative —
      // deriving the text from the number on every render — makes decimals
      // untypeable.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setText(String(value ?? emptyValue));
    }
    // Intentionally keyed on `value` only: reacting to `text` would fight the
    // user's typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <div className="relative">
      {prefix && (
        <span
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-foreground"
          aria-hidden="true"
        >
          {prefix}
        </span>
      )}
      <Input
        type="number"
        inputMode="decimal"
        value={text}
        className={cn("tabular-figures", prefix && "pl-7", className)}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          const parsed = Number.parseFloat(next);
          onChange(Number.isNaN(parsed) ? emptyValue : parsed);
        }}
        onBlur={(event) => {
          // Normalise the display once the user has finished, so "007." and
          // "" both settle into something sensible.
          const parsed = Number.parseFloat(text);
          const settled = Number.isNaN(parsed) ? emptyValue : parsed;
          setText(String(settled));
          onChange(settled);
          onBlur?.(event);
        }}
        {...props}
      />
    </div>
  );
}
