import * as React from "react";
import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-10 w-full min-w-0 rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-xs transition-[color,box-shadow,border-color] outline-none placeholder:text-muted-foreground",
        "file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25",
        "disabled:cursor-not-allowed disabled:opacity-60",
        // Invalid state is conveyed by border *and* ring, never by colour
        // alone — the field also carries aria-invalid for assistive tech.
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
