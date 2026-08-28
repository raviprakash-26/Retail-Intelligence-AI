import "server-only";
import { CompanyStatus } from "@prisma/client";

/**
 * Whether a company can still be worked in.
 *
 * `setCompanyStatus` in the admin service says what suspension is for, in its
 * own words:
 *
 *   > Suspension stops people signing in to it. It does not delete anything,
 *   > and it is reversible by the next administrator who disagrees.
 *
 * It did not stop anything. Three places asked whether a company was reachable
 * and all three asked the same narrower question — `status === "CANCELLED"` —
 * so a suspended business's members went on signing in, posting invoices and
 * filing nothing differently. The administrator pressed the button, watched the
 * status change, saw the audit row, and the shop carried on.
 *
 * Written as an allow-list rather than a deny-list, and deliberately. A deny
 * list is right until somebody adds a fifth status, at which point every reader
 * silently treats it as reachable — which is the failure this whole function
 * exists to undo. Adding a status to the enum now fails to compile here, and
 * the person adding it has to say which side it falls on.
 *
 * A company being unreachable is not the same as a person being suspended.
 * `session.ts` refuses a suspended *user* everywhere, and `team-service` a
 * suspended *membership*; this is the third of the three, and it is the one
 * that was decorative.
 */
const REACHABLE: Record<CompanyStatus, boolean> = {
  // Trading normally.
  [CompanyStatus.ACTIVE]: true,
  // Still being set up. Nothing sets this today — provisioning goes straight to
  // ACTIVE — but a business part-way through setting itself up is one its owner
  // must be able to reach, which is the only answer that could ever be right.
  [CompanyStatus.ONBOARDING]: true,
  // Stopped by an administrator, reversibly. The whole point.
  [CompanyStatus.SUSPENDED]: false,
  // Gone. Kept for the records rather than for use.
  [CompanyStatus.CANCELLED]: false,
};

export function companyIsReachable(status: CompanyStatus): boolean {
  return REACHABLE[status];
}
