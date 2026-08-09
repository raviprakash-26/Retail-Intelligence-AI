import type { Metadata } from "next";
import { PolicyPage } from "@/components/marketing/policy-page";

export const metadata: Metadata = {
  title: "Privacy",
  description:
    "What data Retail Intelligence AI stores, where it lives, who can reach it, and how long it is kept.",
};

export default function PrivacyPolicyPage() {
  return (
    <PolicyPage
      title="Privacy"
      summary="Your books are the most sensitive records your business has. This page describes exactly what the system stores and who can reach it."
      updatedAt="August 2026"
      sections={[
        {
          heading: "What we store",
          paragraphs: [
            "Two categories of data, kept separately in purpose and in access control.",
          ],
          bullets: [
            "Account data: your name, email address, mobile number, a bcrypt hash of your password (never the password itself), and your sign-in history.",
            "Business data: everything you record — customers, suppliers, products, transactions, journal entries, tax working and the reports derived from them.",
          ],
        },
        {
          heading: "Data separation between businesses",
          paragraphs: [
            "Every record belongs to exactly one business. Separation is enforced in the server-side data-access layer, which scopes every query by the business identifier resolved from your session — not by filtering results in the browser.",
            "A signed-in user can only reach data for a business in which they hold an active membership. There is no interface, and no supported query path, that returns records across businesses.",
          ],
        },
        {
          heading: "Who can see your data",
          bullets: [
            "You, and the people you invite to your business, limited by the permissions attached to their role.",
            "Platform administrators can see account and subscription metadata. Access to customer financial records is restricted, requires a specific reason, and is written to an append-only audit log.",
            "No one else. Your business data is not sold, rented or used to train models.",
          ],
        },
        {
          heading: "AI processing",
          paragraphs: [
            "When you use an AI feature, the minimum data needed to answer your question is sent to the configured model provider. That means the specific figures the query returned — not your whole ledger, and never another business's data.",
            "Financial figures themselves are always calculated by application code. The model receives already-computed results to explain; it cannot write to your records.",
            "If no AI provider is configured for your deployment, AI features are visibly unavailable rather than degraded — they will not answer from guesswork.",
          ],
        },
        {
          heading: "Retention and deletion",
          bullets: [
            "Your business data is retained for as long as your account is active.",
            "On cancellation, records remain available for export for 30 days, after which they are deleted.",
            "Financial records you have posted are not deleted while your account is active, because an accounting system that silently drops history is not auditable. They can be voided or reversed, which preserves the trail.",
            "Audit logs are append-only and are retained for the life of the account.",
          ],
        },
        {
          heading: "Security measures",
          bullets: [
            "Passwords are hashed with bcrypt at a configurable work factor. Plaintext passwords are never stored or logged.",
            "Session and reset tokens are stored only as SHA-256 digests, so a database disclosure cannot be replayed as a sign-in.",
            "All traffic is served over HTTPS with HSTS, and security headers are applied to every response.",
            "Uploaded documents are validated on type and size before being accepted.",
          ],
        },
        {
          heading: "Getting your data out",
          paragraphs: [
            "Every report exports to PDF, Excel and CSV at any time, on every plan. Leaving is a supported operation, not a support ticket.",
          ],
        },
        {
          heading: "Contact",
          paragraphs: [
            "Questions about this policy, or a request relating to your data, can be sent to support@retailintelligence.ai. Security disclosures should go to security@retailintelligence.ai.",
          ],
        },
      ]}
    />
  );
}
