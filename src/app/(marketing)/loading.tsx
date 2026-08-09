import { Skeleton } from "@/components/ui/skeleton";

/**
 * Marketing route skeleton. Mirrors the hero-then-cards rhythm every
 * marketing page uses, so the layout does not shift when content arrives.
 */
export default function MarketingLoading() {
  return (
    <div
      className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 lg:px-8"
      aria-busy="true"
      aria-label="Loading page"
    >
      <div className="mx-auto max-w-2xl space-y-4 text-center">
        <Skeleton className="mx-auto h-6 w-40 rounded-full" />
        <Skeleton className="mx-auto h-12 w-full max-w-xl" />
        <Skeleton className="mx-auto h-12 w-3/4" />
        <Skeleton className="mx-auto h-5 w-full max-w-lg" />
        <Skeleton className="mx-auto h-5 w-2/3" />
      </div>

      <div className="mt-14 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-48 rounded-xl" />
        ))}
      </div>
    </div>
  );
}
