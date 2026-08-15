import "server-only";
import { env } from "@/lib/env";

/**
 * Talking to Razorpay.
 *
 * Razorpay was chosen over Stripe because of who this product is for: a shop in
 * Bengaluru is paid by UPI and netbanking far more than by card, and Stripe's
 * India support is not the same product. The driver is still selected by
 * configuration, so a second provider slots in beside this one rather than
 * replacing it.
 *
 * **No card details ever reach this server.** Checkout is hosted by Razorpay:
 * the browser talks to them directly, and we are told an id afterwards. That is
 * the whole reason for using a gateway, and it is what keeps a shopkeeper's
 * customers' card numbers out of a database that was never built to hold them.
 *
 * The HTTP call is injectable — not to make the tests convenient, but because
 * the alternative is untested code. Signature verification, amount checking,
 * idempotency and every state transition are exercised against a transport that
 * returns canned provider responses; what is *not* exercised is the round trip
 * to Razorpay itself, and the README says so rather than implying this has been
 * run against production credentials.
 */

const API_ROOT = "https://api.razorpay.com/v1";
const REQUEST_TIMEOUT_MS = 15_000;

export class PaymentProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    /** True when retrying the same request might work. */
    readonly retryable = false,
  ) {
    super(message);
    this.name = "PaymentProviderError";
  }
}

/** The subset of an order this product cares about. */
export type ProviderOrder = {
  id: string;
  amountMinor: number;
  currency: string;
  status: string;
};

/** The subset of a payment this product cares about. */
export type ProviderPayment = {
  id: string;
  orderId: string | null;
  amountMinor: number;
  currency: string;
  status: string;
  method: string | null;
  capturedAt: Date | null;
  errorDescription: string | null;
};

export type Transport = (
  url: string,
  init: RequestInit,
) => Promise<{ status: number; body: unknown }>;

/**
 * The real transport.
 *
 * Bounded by a timeout because a gateway that stops answering must not hold a
 * request open until the platform runs out of workers — the person waiting
 * would rather be told to try again than watch a spinner for two minutes.
 */
const httpTransport: Transport = async (url, init) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
};

export type RazorpayCredentials = { keyId: string; keySecret: string };

/**
 * The configured credentials, or null.
 *
 * Null is a normal state, not a fault: most installations of this product will
 * never take a payment, and the billing page is built to say so.
 */
export function razorpayCredentials(): RazorpayCredentials | null {
  if (env.PAYMENTS_DRIVER !== "razorpay") return null;
  const keyId = env.RAZORPAY_KEY_ID;
  const keySecret = env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) return null;
  return { keyId, keySecret };
}

function authorizationHeader(credentials: RazorpayCredentials): string {
  const encoded = Buffer.from(
    `${credentials.keyId}:${credentials.keySecret}`,
    "utf8",
  ).toString("base64");
  return `Basic ${encoded}`;
}

function describeFailure(status: number, body: unknown): PaymentProviderError {
  const description =
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof (body as { error?: { description?: unknown } }).error
      ?.description === "string"
      ? (body as { error: { description: string } }).error.description
      : `The payment provider answered ${status}.`;

  // 5xx and 429 are worth another go; a 400 means we sent something wrong and
  // sending it again will produce the same answer.
  const retryable = status >= 500 || status === 429;
  return new PaymentProviderError(description, `HTTP_${status}`, retryable);
}

function readNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new PaymentProviderError(
      `The payment provider sent a ${field} that is not a whole number of paise.`,
      "MALFORMED_RESPONSE",
    );
  }
  return value;
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new PaymentProviderError(
      `The payment provider sent no ${field}.`,
      "MALFORMED_RESPONSE",
    );
  }
  return value;
}

export class RazorpayClient {
  constructor(
    private readonly credentials: RazorpayCredentials,
    private readonly transport: Transport = httpTransport,
  ) {}

  private async call(
    path: string,
    init: RequestInit = {},
  ): Promise<Record<string, unknown>> {
    let result: { status: number; body: unknown };
    try {
      result = await this.transport(`${API_ROOT}${path}`, {
        ...init,
        headers: {
          authorization: authorizationHeader(this.credentials),
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
      });
    } catch (error) {
      // A network failure is not a declined payment, and must never be
      // reported as one. Nothing has been decided at this point.
      throw new PaymentProviderError(
        `Could not reach the payment provider: ${error instanceof Error ? error.message : String(error)}`,
        "UNREACHABLE",
        true,
      );
    }

    if (result.status < 200 || result.status >= 300) {
      throw describeFailure(result.status, result.body);
    }
    if (typeof result.body !== "object" || result.body === null) {
      throw new PaymentProviderError(
        "The payment provider sent a response that could not be read.",
        "MALFORMED_RESPONSE",
      );
    }
    return result.body as Record<string, unknown>;
  }

  /**
   * Creates the order the browser will pay against.
   *
   * `receipt` carries our own invoice id, so a payment can always be traced
   * back to what it was for even if every other link were lost. `amountMinor`
   * is paise — Razorpay's unit and ours are the same, which is why nothing here
   * multiplies by a hundred. A conversion is exactly where a rounding error
   * would enter, so there is deliberately not one.
   */
  async createOrder(params: {
    amountMinor: number;
    currency: string;
    receipt: string;
    notes?: Record<string, string>;
  }): Promise<ProviderOrder> {
    if (!Number.isInteger(params.amountMinor) || params.amountMinor <= 0) {
      throw new PaymentProviderError(
        "An order has to be for a whole number of paise, greater than zero.",
        "INVALID_AMOUNT",
      );
    }

    const body = await this.call("/orders", {
      method: "POST",
      body: JSON.stringify({
        amount: params.amountMinor,
        currency: params.currency,
        receipt: params.receipt,
        // Razorpay's own idempotency: the same receipt will not create a
        // second order while the first is still open.
        payment_capture: 1,
        notes: params.notes ?? {},
      }),
    });

    return {
      id: readString(body.id, "order id"),
      amountMinor: readNumber(body.amount, "amount"),
      currency: readString(body.currency, "currency"),
      status: readString(body.status, "status"),
    };
  }

  /**
   * Reads a payment back from the provider.
   *
   * This is the authority. What the browser said and what a webhook body
   * claimed are both worth checking, but neither is worth trusting on its own,
   * and a direct read costs one request.
   */
  async getPayment(paymentId: string): Promise<ProviderPayment> {
    const body = await this.call(`/payments/${encodeURIComponent(paymentId)}`);
    return readPayment(body);
  }
}

/** Shapes a payment object from either an API read or a webhook payload. */
export function readPayment(body: Record<string, unknown>): ProviderPayment {
  const capturedAt =
    typeof body.captured_at === "number"
      ? new Date(body.captured_at * 1000)
      : null;

  return {
    id: readString(body.id, "payment id"),
    orderId: typeof body.order_id === "string" ? body.order_id : null,
    amountMinor: readNumber(body.amount, "amount"),
    currency: readString(body.currency, "currency"),
    status: readString(body.status, "status"),
    method: typeof body.method === "string" ? body.method : null,
    capturedAt,
    errorDescription:
      typeof body.error_description === "string"
        ? body.error_description
        : null,
  };
}
