import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The document email cannot be pointed at a stranger.
 *
 * A feature that accepts "send this document to that address" is an open relay
 * with extra steps: it sends mail from a domain the recipient's spam filter
 * trusts, with a business's real name on it, to anybody the caller names. The
 * control is that **there is no address in the request** — the caller names a
 * document and the recipient is read off the customer record attached to it.
 *
 * That control lives in the shape of the input schema, which is the kind of
 * thing a later change could widen without anybody noticing the consequence.
 * So it is asserted here by reading the source: the integration tests cannot
 * prove the absence of a parameter, but this can.
 */

const SOURCE = readFileSync("src/server/documents/actions.ts", "utf8");

describe("the send action takes no address", () => {
  it("accepts only an id", () => {
    // The schema is the boundary. If it ever grows an email field, this fails
    // and somebody has to argue for it.
    const schema = SOURCE.match(/const schema = z\.object\(\{([\s\S]*?)\}\);/);
    expect(schema, "the input schema could not be found").not.toBeNull();

    const body = schema?.[1] ?? "";
    expect(body).toContain("id:");
    expect(body.toLowerCase()).not.toContain("email");
    expect(body.toLowerCase()).not.toContain("to:");
    expect(body.toLowerCase()).not.toContain("recipient");
  });

  it("reads the recipient from the customer record, not the input", () => {
    // Both actions resolve `to` the same way, off a relation on the document.
    const reads = SOURCE.match(/const to = \w+\.customer\?\.email/g) ?? [];
    expect(reads.length).toBe(2);
  });

  it("never passes a caller-supplied value as the address", () => {
    // `parsed.data` is the request. It may reach the lookup, never the mailer.
    expect(SOURCE).not.toMatch(/to:\s*parsed\.data/);
    expect(SOURCE).not.toMatch(/sendEmail\([^)]*parsed\.data\.(to|email)/);
  });

  it("scopes every lookup to the signed-in company", () => {
    // Naming another tenant's invoice id must not send that tenant's document
    // anywhere, so the id is always paired with the company from the session.
    const lookups =
      SOURCE.match(/where: \{ id: parsed\.data\.id[^}]*\}/g) ?? [];
    expect(lookups.length).toBe(2);
    for (const lookup of lookups) {
      expect(lookup).toContain("companyId: context.company.id");
    }
  });

  it("is rate limited and logged", () => {
    expect(SOURCE).toContain("DOCUMENT_EMAIL_COMPANY");
    expect(SOURCE).toContain("recordAuditLog");
    expect(SOURCE).toContain("requireSameOrigin");
  });
});
