import { handleRazorpayWebhook } from "@/server/billing/webhook";

/**
 * Where the payment provider tells us a payment happened.
 *
 * Three things about this route are deliberate and easy to get wrong.
 *
 * **The body is read as text.** The signature is computed over the exact bytes
 * Razorpay sent, so parsing to JSON and re-serialising would change key order
 * and whitespace and break every signature — a failure that looks like a
 * provider outage and is not.
 *
 * **There is no session and no origin check.** This is not a browser request
 * and there is nobody signed in; the signature *is* the authentication. That
 * makes it the one publicly reachable endpoint in the product that changes what
 * a business has paid for, which is why the verification lives behind a
 * constant-time comparison and every delivery is recorded whether or not it
 * passed.
 *
 * **A failure to apply still answers 200.** Providers retry on any non-2xx, so
 * returning 500 for an event we understood and decided not to act on — a
 * duplicate, an unknown order — would earn an unbounded retry storm for
 * something that will never change. Only a genuinely unprocessed event should
 * be retried, and the handler distinguishes the two.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();

  const result = await handleRazorpayWebhook({
    rawBody,
    signature: request.headers.get("x-razorpay-signature"),
    eventId: request.headers.get("x-razorpay-event-id"),
  });

  if (!result.handled) {
    return new Response(result.outcome, {
      status: result.status,
      headers: { "cache-control": "no-store" },
    });
  }

  return Response.json(
    { received: true, outcome: result.outcome },
    { headers: { "cache-control": "no-store" } },
  );
}

/**
 * Nothing to see here.
 *
 * A GET would otherwise render Next's 405 page, which is a lot of HTML for a
 * URL that only ever receives one kind of request.
 */
export async function GET(): Promise<Response> {
  return new Response("Not found", { status: 404 });
}
