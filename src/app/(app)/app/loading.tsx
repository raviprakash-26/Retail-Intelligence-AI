import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shell-level loading state.
 *
 * Mirrors the dashboard's rhythm — heading, KPI row, two panels — so the page
 * does not jump when the real content arrives. The chrome around it is already
 * rendered by the layout, so only the main region needs a placeholder.
 */
export default function AppLoading() {
  return (
    <div
      className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 sm:px-6"
      aria-busy="true"
      aria-label="Loading"
    >
      <div className="space-y-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-40" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-24 rounded-xl" />
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, index) => (
          <Skeleton key={index} className="h-24 rounded-xl" />
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  );
}
