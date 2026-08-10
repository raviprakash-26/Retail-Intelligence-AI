import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

/**
 * Form-level error banner.
 *
 * `role="alert"` is on the underlying Alert, so the message is announced as
 * soon as it appears rather than only when the user next moves focus.
 */
export function FormError({
  message,
  retryAfterSeconds,
}: {
  message: string | null;
  retryAfterSeconds?: number | null;
}) {
  if (!message) return null;

  return (
    <Alert variant="destructive">
      <TriangleAlert />
      <AlertDescription>
        <p>{message}</p>
        {retryAfterSeconds ? (
          <p className="text-xs opacity-80">
            You can try again in {formatWait(retryAfterSeconds)}.
          </p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? "a minute" : `${minutes} minutes`;
}
