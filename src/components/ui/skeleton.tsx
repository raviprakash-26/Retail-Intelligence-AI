import { cn } from "@/lib/utils";

/**
 * Loading placeholder.
 *
 * Skeletons should mirror the shape of the content they stand in for, so the
 * layout does not jump when data arrives. They are hidden from assistive
 * technology — a screen reader announcing a dozen empty boxes is noise; the
 * surrounding region carries `aria-busy` instead.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("animate-shimmer rounded-md bg-muted", className)}
      {...props}
    />
  );
}

export { Skeleton };
