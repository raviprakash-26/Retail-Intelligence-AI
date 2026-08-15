import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Proving a message came from the payment provider.
 *
 * Everything else in this module depends on these two functions being right.
 * A payment is a claim that money moved, and the only thing separating a real
 * claim from one somebody typed into `curl` is a signature computed with a
 * secret the two parties share. Get this wrong and an attacker upgrades their
 * own subscription for nothing — or, worse, marks somebody else's invoice paid.
 *
 * Razorpay uses HMAC-SHA256 in two places, with two different secrets and two
 * different messages, and confusing them is the classic way this is broken:
 *
 *   • **Checkout**, when the browser comes back from paying:
 *     `HMAC(order_id + "|" + payment_id, KEY_SECRET)`
 *   • **Webhooks**, server to server:
 *     `HMAC(raw_request_body, WEBHOOK_SECRET)`
 *
 * The webhook one has to be computed over the bytes exactly as they arrived.
 * Parsing the JSON and re-serialising it changes key order and whitespace, and
 * the signature stops matching for reasons that look like a provider outage.
 */

/**
 * Constant-time comparison of two hex digests.
 *
 * `timingSafeEqual` throws when the buffers differ in length, so the length
 * check in front of it is load-bearing rather than an optimisation — and it is
 * done on the encoded strings, before any allocation, so a wrong-length
 * signature costs nothing to reject.
 *
 * A plain `===` here would leak the correct signature one byte at a time to
 * anybody willing to make enough requests. That is a real attack on a
 * remotely-reachable endpoint, not a theoretical one.
 */
export function signaturesMatch(expected: string, provided: string): boolean {
  if (typeof provided !== "string" || expected.length !== provided.length) {
    return false;
  }
  try {
    return timingSafeEqual(
      Buffer.from(expected, "utf8"),
      Buffer.from(provided, "utf8"),
    );
  } catch {
    return false;
  }
}

/** The signature Razorpay computes over a webhook's body. */
export function webhookSignature(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

export function verifyWebhookSignature(params: {
  rawBody: string;
  signature: string | null;
  secret: string;
}): boolean {
  if (!params.signature || !params.secret) return false;
  return signaturesMatch(
    webhookSignature(params.rawBody, params.secret),
    params.signature,
  );
}

/** The signature Razorpay Checkout hands back to the browser. */
export function checkoutSignature(params: {
  orderId: string;
  paymentId: string;
  keySecret: string;
}): string {
  return createHmac("sha256", params.keySecret)
    .update(`${params.orderId}|${params.paymentId}`, "utf8")
    .digest("hex");
}

/**
 * Whether the browser's callback is genuine.
 *
 * Worth being precise about what this proves and what it does not. It proves
 * the payload was produced by somebody holding the key secret — so it was not
 * forged by the person sitting at the browser. It does **not** prove the
 * payment succeeded, was for the right amount, or has not already been used:
 * the browser is a hostile narrator even when it is telling the truth, because
 * it can simply never come back. Only the webhook, and a direct read of the
 * payment from the provider, settle those.
 */
export function verifyCheckoutSignature(params: {
  orderId: string;
  paymentId: string;
  signature: string;
  keySecret: string;
}): boolean {
  return signaturesMatch(
    checkoutSignature({
      orderId: params.orderId,
      paymentId: params.paymentId,
      keySecret: params.keySecret,
    }),
    params.signature,
  );
}
