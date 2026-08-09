import { Info } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * Honest placeholder for the authentication backend.
 *
 * Phase 1 delivers the interface; sessions, password hashing at rest, email
 * verification and rate limiting land in Phase 2. Rather than wiring these
 * forms to a stub that returns a fabricated success — which would teach users
 * to trust a screen that did nothing — the forms validate fully and say
 * plainly that submission is not connected yet.
 *
 * Delete this component when the server actions land.
 */
export function AuthBackendNotice({ action }: { action: string }) {
  return (
    <Alert variant="info">
      <Info />
      <AlertTitle>Not connected yet</AlertTitle>
      <AlertDescription>
        <p>
          This form validates exactly as it will in production, but {action} is
          wired up in the next phase of the build. Nothing has been saved and no
          account has been created.
        </p>
      </AlertDescription>
    </Alert>
  );
}
