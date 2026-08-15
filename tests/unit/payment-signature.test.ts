import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  checkoutSignature,
  signaturesMatch,
  verifyCheckoutSignature,
  verifyWebhookSignature,
  webhookSignature,
} from "@/server/billing/signature";

/**
 * Proving a payment message is genuine.
 *
 * This is the whole security boundary of the payments module: past it, a
 * message is treated as the provider's own word that money moved. So the cases
 * here are mostly attacks — a forged body, a truncated signature, the right
 * signature computed with the wrong secret, and the classic one of signing a
 * re-serialised body instead of the bytes that actually arrived.
 */

const SECRET = "a-webhook-secret-nobody-else-has";
const KEY_SECRET = "a-key-secret-nobody-else-has";

const BODY = JSON.stringify({
  event: "payment.captured",
  payload: { payment: { entity: { id: "pay_123", amount: 499900 } } },
});

const sign = (body: string, secret = SECRET) =>
  createHmac("sha256", secret).update(body, "utf8").digest("hex");

describe("webhook signatures", () => {
  it("accepts a body signed with the shared secret", () => {
    expect(
      verifyWebhookSignature({
        rawBody: BODY,
        signature: sign(BODY),
        secret: SECRET,
      }),
    ).toBe(true);
  });

  it("rejects a body that was changed after signing", () => {
    // The attack this exists to stop: take a real captured-payment webhook and
    // edit the amount before replaying it.
    const signature = sign(BODY);
    const tampered = BODY.replace("499900", "100");

    expect(
      verifyWebhookSignature({
        rawBody: tampered,
        signature,
        secret: SECRET,
      }),
    ).toBe(false);
  });

  it("rejects a signature computed with a different secret", () => {
    expect(
      verifyWebhookSignature({
        rawBody: BODY,
        signature: sign(BODY, "some-other-secret"),
        secret: SECRET,
      }),
    ).toBe(false);
  });

  it("rejects a missing signature rather than treating absence as valid", () => {
    expect(
      verifyWebhookSignature({
        rawBody: BODY,
        signature: null,
        secret: SECRET,
      }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({ rawBody: BODY, signature: "", secret: SECRET }),
    ).toBe(false);
  });

  it("rejects everything when no secret is configured", () => {
    // An installation with no secret must not accept every webhook that
    // arrives — which is what an empty-string HMAC comparison would do.
    expect(
      verifyWebhookSignature({
        rawBody: BODY,
        signature: sign(BODY),
        secret: "",
      }),
    ).toBe(false);
  });

  it("depends on the exact bytes, not the parsed object", () => {
    // Why the route reads the body as text. Re-serialising the same JSON
    // reorders keys and drops whitespace, and the signature stops matching for
    // a reason that looks like a provider outage.
    const signature = sign(BODY);
    const reserialised = JSON.stringify(JSON.parse(BODY));
    const spaced = `${BODY} `;

    expect(
      verifyWebhookSignature({
        rawBody:
          reserialised === BODY ? `{"event":"payment.captured"}` : reserialised,
        signature,
        secret: SECRET,
      }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({ rawBody: spaced, signature, secret: SECRET }),
    ).toBe(false);
  });

  it("produces a hex digest of the length Razorpay sends", () => {
    expect(webhookSignature(BODY, SECRET)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("checkout signatures", () => {
  const orderId = "order_abc123";
  const paymentId = "pay_xyz789";

  it("accepts the payload the widget hands back", () => {
    expect(
      verifyCheckoutSignature({
        orderId,
        paymentId,
        signature: checkoutSignature({
          orderId,
          paymentId,
          keySecret: KEY_SECRET,
        }),
        keySecret: KEY_SECRET,
      }),
    ).toBe(true);
  });

  it("is bound to both ids, so one cannot be swapped for another", () => {
    // Otherwise a signature from a ₹100 order could be presented against a
    // ₹5,000 one.
    const signature = checkoutSignature({
      orderId,
      paymentId,
      keySecret: KEY_SECRET,
    });

    expect(
      verifyCheckoutSignature({
        orderId: "order_someone_elses",
        paymentId,
        signature,
        keySecret: KEY_SECRET,
      }),
    ).toBe(false);
    expect(
      verifyCheckoutSignature({
        orderId,
        paymentId: "pay_someone_elses",
        signature,
        keySecret: KEY_SECRET,
      }),
    ).toBe(false);
  });

  it("uses the separator Razorpay uses, not concatenation", () => {
    // "order_a" + "pay_b" and "order_ap" + "ay_b" must not sign the same. The
    // pipe is what makes the message unambiguous.
    const naive = createHmac("sha256", KEY_SECRET)
      .update(`${orderId}${paymentId}`, "utf8")
      .digest("hex");
    expect(
      checkoutSignature({ orderId, paymentId, keySecret: KEY_SECRET }),
    ).not.toBe(naive);
  });
});

describe("comparing digests", () => {
  it("rejects a signature of the wrong length without throwing", () => {
    // timingSafeEqual throws on unequal lengths, so the guard in front of it is
    // load-bearing: without it a short signature would be a 500 rather than a
    // rejection, and a 500 is a retry loop.
    expect(signaturesMatch("a".repeat(64), "a")).toBe(false);
    expect(signaturesMatch("a".repeat(64), "")).toBe(false);
    expect(signaturesMatch("a".repeat(64), "a".repeat(65))).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(signaturesMatch("a".repeat(64), null as unknown as string)).toBe(
      false,
    );
    expect(
      signaturesMatch("a".repeat(64), undefined as unknown as string),
    ).toBe(false);
  });

  it("accepts an exact match", () => {
    expect(signaturesMatch("abc123", "abc123")).toBe(true);
  });

  it("rejects a near match", () => {
    expect(signaturesMatch("abc123", "abc124")).toBe(false);
  });
});
