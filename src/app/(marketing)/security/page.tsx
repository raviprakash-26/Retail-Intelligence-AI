import type { Metadata } from "next";
import { PolicyPage } from "@/components/marketing/policy-page";

export const metadata: Metadata = {
  title: "Security",
  description:
    "How Retail Intelligence AI protects accounts, isolates tenants and preserves the integrity of financial records.",
};

export default function SecurityPage() {
  return (
    <PolicyPage
      title="Security"
      summary="How accounts are protected, how businesses are kept separate, and how the integrity of your ledger is enforced."
      updatedAt="August 2026"
      sections={[
        {
          heading: "Authentication",
          bullets: [
            "Passwords are hashed with bcrypt using a per-password salt and a configurable work factor.",
            "Sessions are opaque random tokens with 256 bits of entropy. Only their SHA-256 digest is stored, so the session table cannot be used to impersonate a user.",
            "Session cookies are HttpOnly, Secure and SameSite-restricted, so they are unreadable from JavaScript and are not sent on cross-site requests.",
            "Repeated failed sign-ins lock an account temporarily. Sign-in responses are uniform whether or not the address exists, so the endpoint cannot be used to enumerate customers.",
            "Changing a password or revoking access invalidates every existing session for that user immediately.",
          ],
        },
        {
          heading: "Tenant isolation",
          bullets: [
            "Every tenant-owned row carries the identifier of the business it belongs to.",
            "Queries are constructed only in the server-side data-access layer, which always scopes by that identifier. The identifier comes from the session, never from a request parameter.",
            "Unique constraints are composite with the business identifier, so two businesses can independently use the same invoice numbers, product codes and account codes without collision.",
          ],
        },
        {
          heading: "Authorization",
          bullets: [
            "Access is permission-based. The code asks whether a member may perform a specific action, not what their job title is.",
            "Roles are named bundles of permissions and can be customised without code changes.",
            "Every protected operation is checked on the server. Interface elements are hidden when a permission is absent, but hiding a button is presentation, not enforcement.",
          ],
        },
        {
          heading: "Financial integrity",
          bullets: [
            "Journal lines carry a database check constraint requiring exactly one non-negative side, so a two-sided or negative line cannot be written.",
            "A deferred constraint trigger verifies that every posted entry balances and agrees with its control totals before the transaction is allowed to commit.",
            "Posted entries and their lines are protected by triggers that reject modification and deletion; corrections go through reversal.",
            "Multi-table operations — a sale and its items, stock movement, journal and tax records — run inside a single database transaction. A partial write is not possible.",
            "Monetary values are fixed-point decimals throughout. Floating-point arithmetic is not used for money anywhere in the system.",
          ],
        },
        {
          heading: "Auditability",
          bullets: [
            "Sign-ins, transaction creation and voiding, permission changes, configuration changes, report exports and administrative access are all written to an audit log.",
            "The audit log is append-only, enforced by a database trigger that rejects updates and deletes outright.",
          ],
        },
        {
          heading: "Application hardening",
          bullets: [
            "All input is validated against explicit schemas on the server, regardless of what the browser already checked.",
            "Database access goes through a query builder with parameterised statements, so string-concatenated SQL is not part of the codebase.",
            "Security headers — HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy and a restrictive Permissions-Policy — are applied to every response.",
            "Secrets are read from validated environment configuration and are never exposed to the browser. The application refuses to start with an invalid configuration.",
          ],
        },
        {
          heading: "Reporting a vulnerability",
          paragraphs: [
            "Send details to security@retailintelligence.ai. We acknowledge every report, will not pursue action against good-faith research, and will keep you informed until the issue is resolved.",
          ],
        },
      ]}
    />
  );
}
