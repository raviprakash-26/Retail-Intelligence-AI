import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RegisterInput } from "@/lib/validation/auth";
import { registerOwner } from "@/server/auth/registration";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * Taking a payment, and refusing to.
 *
 * The signature arithmetic is unit-tested. What needs a database is everything
 * that decides whether somebody ends up on a plan they did not pay for: the
 * amount check, the idempotency of a redelivered webhook, the refusal to act on
 * an unsigned body, and the fact that a browser has no path to marking anything
 * paid.
 *
 * `env` parses the environment once, at import — so the credentials have to be
 * in place before the modules under test are loaded, which is why they are set
 * here and the imports are dynamic.
 */

const WEBHOOK_SECRET = "a-webhook-secret-for-tests-only";

process.env.PAYMENTS_DRIVER = "razorpay";
process.env.RAZORPAY_KEY_ID = "rzp_test_keyid";
process.env.RAZORPAY_KEY_SECRET = "rzp_test_keysecret";
process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;

vi.resetModules();
const { handleRazorpayWebhook } = await import("@/server/billing/webhook");
const { startPlanUpgrade, CheckoutError } =
  await import("@/server/billing/checkout");
const { paymentsStatus } = await import("@/server/billing/payments");
const { PaymentProviderError } = await import("@/server/billing/razorpay");

const prisma = testDb();
const createdCompanies: string[] = [];
const createdEmails: string[] = [];

function registrationInput(email: string): RegisterInput {
  return {
    account: {
      fullName: "Ravi Prakash",
      email,
      mobile: "9845012345",
      password: "MountainRiver42!",
      confirmPassword: "MountainRiver42!",
      acceptTerms: true,
    },
    business: {
      businessName: `Pay ${uniqueSlug("Mart")}`,
      businessType: "SOLE_PROPRIETORSHIP",
      gstRegistration: "REGULAR",
      gstin: "29AAAPR1234K1ZP",
      pan: "AAAPR1234K",
      addressLine1: "42 Avenue Road",
      city: "Bengaluru",
      stateCode: "29",
      pincode: "560053",
    },
    accounting: {
      fiscalYearStartMonth: 4,
      currency: "INR",
      openingCashBalance: 0,
      openingBankBalance: 0,
      inventoryMethod: "WEIGHTED_AVERAGE",
      loadDemoData: false,
    },
  };
}

/**
 * A unique event id per run.
 *
 * Payment events are append-only and survive the company purge that cleans up
 * everything else, so a fixed id passes on a fresh database and reports
 * DUPLICATE on every run after it. Provider event ids are unique in reality;
 * the fixtures should be too.
 */
const evt = (label: string) =>
  `evt_${label}_${uniqueSlug("x").replace(/-/g, "")}`;

type Fixture = { companyId: string; userId: string; email: string };

async function createCompany(): Promise<Fixture> {
  const email = `pay-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const result = await registerOwner(registrationInput(email));
  createdCompanies.push(result.companyId);
  return { companyId: result.companyId, userId: result.userId, email };
}

/** A transport that answers like Razorpay without touching the network. */
function fakeTransport(
  responses:
    | { status: number; body: unknown }[]
    | ((url: string) => { status: number; body: unknown }),
) {
  const calls: { url: string; body: unknown }[] = [];
  let index = 0;
  const transport = async (url: string, init: RequestInit) => {
    calls.push({
      url,
      body: typeof init.body === "string" ? JSON.parse(init.body) : null,
    });
    if (typeof responses === "function") return responses(url);
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return next!;
  };
  return { transport, calls };
}

function orderResponse(amountMinor: number, id = "order_test_1") {
  return {
    status: 200,
    body: {
      id,
      entity: "order",
      amount: amountMinor,
      currency: "INR",
      status: "created",
    },
  };
}

/** A captured-payment webhook, signed the way Razorpay signs one. */
function capturedWebhook(params: {
  orderId: string;
  paymentId?: string;
  amountMinor: number;
  currency?: string;
  status?: string;
  event?: string;
}) {
  const body = JSON.stringify({
    entity: "event",
    event: params.event ?? "payment.captured",
    payload: {
      payment: {
        entity: {
          id: params.paymentId ?? "pay_test_1",
          order_id: params.orderId,
          amount: params.amountMinor,
          currency: params.currency ?? "INR",
          status: params.status ?? "captured",
          method: "upi",
          captured_at: Math.floor(Date.now() / 1000),
        },
      },
    },
  });
  return {
    rawBody: body,
    signature: createHmac("sha256", WEBHOOK_SECRET)
      .update(body, "utf8")
      .digest("hex"),
  };
}

/**
 * The plan an upgrade goes *to* — the second rung, not the first.
 *
 * Every plan in this product costs something, so "upgrade" means moving up the
 * ladder rather than off a free tier. Tests put a company on the cheapest plan
 * and buy this one.
 */
async function paidPlan() {
  const plans = await prisma.subscriptionPlan.findMany({
    where: { isActive: true },
    orderBy: { priceMinor: "asc" },
    select: { id: true, key: true, name: true, priceMinor: true },
  });
  const target = plans[1] ?? plans[0];
  if (!target) throw new Error("No subscription plans are seeded.");
  return target;
}

async function cheapestPlan() {
  return prisma.subscriptionPlan.findFirstOrThrow({
    where: { isActive: true },
    orderBy: { priceMinor: "asc" },
    select: { id: true, key: true, priceMinor: true },
  });
}

async function currentPlanKey(companyId: string): Promise<string> {
  const subscription = await prisma.subscription.findUniqueOrThrow({
    where: { companyId },
    select: { plan: { select: { key: true } } },
  });
  return subscription.plan.key;
}

/** Puts the company on the cheapest plan, so an upgrade genuinely costs money. */
async function putOnFreePlan(companyId: string): Promise<void> {
  const cheapest = await cheapestPlan();
  await prisma.subscription.update({
    where: { companyId },
    data: { planId: cheapest.id },
  });
}

beforeAll(async () => {
  await ensurePlatformData();
}, 120_000);

afterAll(async () => {
  for (const companyId of createdCompanies) await purgeTestCompany(companyId);
  await purgeTestUsers(createdEmails);
  await disconnectTestDb();
}, 120_000);

describe("whether this installation can charge anybody", () => {
  it("says yes only when both the keys and the webhook secret are present", () => {
    // The webhook secret is not optional. Without it a checkout could be
    // opened and never confirmed, which takes somebody's money and leaves
    // their plan untouched.
    expect(paymentsStatus()).toEqual({ available: true, provider: "razorpay" });
  });
});

describe("opening a checkout", () => {
  it("creates a pending invoice and an order for the plan's own price", async () => {
    const fixture = await createCompany();
    await putOnFreePlan(fixture.companyId);
    const plan = await paidPlan();
    const { transport, calls } = fakeTransport([
      orderResponse(plan.priceMinor),
    ]);

    const session = await startPlanUpgrade({
      companyId: fixture.companyId,
      planKey: plan.key,
      userId: fixture.userId,
      actorEmail: fixture.email,
      userName: "Ravi Prakash",
      transport,
    });

    expect(session.amountMinor).toBe(plan.priceMinor);
    expect(session.orderId).toBe("order_test_1");
    // The public key id goes to the browser; the secret has no field to travel in.
    expect(session.keyId).toBe("rzp_test_keyid");
    expect(JSON.stringify(session)).not.toContain("rzp_test_keysecret");

    // The amount sent to the provider came from the plan, not from the caller.
    expect((calls[0]?.body as { amount: number }).amount).toBe(plan.priceMinor);

    const invoice = await prisma.subscriptionInvoice.findUniqueOrThrow({
      where: { id: session.invoiceId },
      select: {
        status: true,
        amountMinor: true,
        providerInvoiceId: true,
        targetPlanId: true,
      },
    });
    expect(invoice.status).toBe("PENDING");
    expect(invoice.amountMinor).toBe(plan.priceMinor);
    expect(invoice.providerInvoiceId).toBe("order_test_1");
    // The plan is named on the invoice rather than inferred later from price.
    expect(invoice.targetPlanId).toBe(plan.id);

    // And nothing has been granted by asking to pay.
    expect(await currentPlanKey(fixture.companyId)).not.toBe(plan.key);
  }, 90_000);

  it("reuses an open checkout instead of stacking up invoices", async () => {
    // Somebody who closes the payment window and comes back should not end up
    // with two orders for one upgrade.
    const fixture = await createCompany();
    await putOnFreePlan(fixture.companyId);
    const plan = await paidPlan();
    const { transport } = fakeTransport([orderResponse(plan.priceMinor)]);

    const first = await startPlanUpgrade({
      companyId: fixture.companyId,
      planKey: plan.key,
      userId: fixture.userId,
      actorEmail: fixture.email,
      userName: "Ravi Prakash",
      transport,
    });
    const second = await startPlanUpgrade({
      companyId: fixture.companyId,
      planKey: plan.key,
      userId: fixture.userId,
      actorEmail: fixture.email,
      userName: "Ravi Prakash",
      transport,
    });

    expect(second.invoiceId).toBe(first.invoiceId);
    const count = await prisma.subscriptionInvoice.count({
      where: { subscription: { companyId: fixture.companyId } },
    });
    expect(count).toBe(1);
  }, 90_000);

  it("refuses a move that costs nothing rather than collecting nothing", async () => {
    const fixture = await createCompany();
    const plan = await paidPlan();
    // Already on a plan at least as expensive.
    await prisma.subscription.update({
      where: { companyId: fixture.companyId },
      data: { planId: plan.id },
    });
    const cheaper = await cheapestPlan();
    const { transport } = fakeTransport([orderResponse(cheaper.priceMinor)]);

    await expect(
      startPlanUpgrade({
        companyId: fixture.companyId,
        planKey: cheaper.key,
        userId: fixture.userId,
        actorEmail: fixture.email,
        userName: "Ravi Prakash",
        transport,
      }),
    ).rejects.toThrow(CheckoutError);
  }, 90_000);

  it("records the failure when the provider refuses, and charges nothing", async () => {
    const fixture = await createCompany();
    await putOnFreePlan(fixture.companyId);
    const plan = await paidPlan();
    const { transport } = fakeTransport([
      { status: 400, body: { error: { description: "Invalid amount" } } },
    ]);

    await expect(
      startPlanUpgrade({
        companyId: fixture.companyId,
        planKey: plan.key,
        userId: fixture.userId,
        actorEmail: fixture.email,
        userName: "Ravi Prakash",
        transport,
      }),
    ).rejects.toThrow(PaymentProviderError);

    // The attempt is kept, marked failed with the reason — that is what a
    // support conversation needs, and deleting it would erase the evidence.
    const invoice = await prisma.subscriptionInvoice.findFirstOrThrow({
      where: { subscription: { companyId: fixture.companyId } },
      select: { status: true, failureReason: true },
    });
    expect(invoice.status).toBe("FAILED");
    expect(invoice.failureReason).toMatch(/Invalid amount/);
    expect(await currentPlanKey(fixture.companyId)).not.toBe(plan.key);
  }, 90_000);

  it("refuses an order the provider created for a different amount", async () => {
    // Defence against the provider, not just against the browser. Charging
    // against an echoed-back amount would collect something other than the
    // price on the page.
    const fixture = await createCompany();
    await putOnFreePlan(fixture.companyId);
    const plan = await paidPlan();
    const { transport } = fakeTransport([orderResponse(plan.priceMinor - 100)]);

    await expect(
      startPlanUpgrade({
        companyId: fixture.companyId,
        planKey: plan.key,
        userId: fixture.userId,
        actorEmail: fixture.email,
        userName: "Ravi Prakash",
        transport,
      }),
    ).rejects.toThrow(/different amount/i);
  }, 90_000);
});

describe("a webhook saying the payment succeeded", () => {
  async function openCheckout(orderId: string) {
    const fixture = await createCompany();
    await putOnFreePlan(fixture.companyId);
    const plan = await paidPlan();
    const { transport } = fakeTransport([
      orderResponse(plan.priceMinor, orderId),
    ]);
    const session = await startPlanUpgrade({
      companyId: fixture.companyId,
      planKey: plan.key,
      userId: fixture.userId,
      actorEmail: fixture.email,
      userName: "Ravi Prakash",
      transport,
    });
    return { fixture, plan, session };
  }

  it("marks the invoice paid and moves the plan", async () => {
    const { fixture, plan, session } = await openCheckout(
      `order_paid1_${uniqueSlug("o")}`,
    );
    const hook = capturedWebhook({
      orderId: session.orderId,
      amountMinor: plan.priceMinor,
    });

    const result = await handleRazorpayWebhook({
      ...hook,
      eventId: evt("paid_1"),
    });

    expect(result.handled).toBe(true);
    const invoice = await prisma.subscriptionInvoice.findUniqueOrThrow({
      where: { id: session.invoiceId },
      select: { status: true, paidAt: true, providerPaymentId: true },
    });
    expect(invoice.status).toBe("PAID");
    expect(invoice.paidAt).not.toBeNull();
    expect(invoice.providerPaymentId).toBe("pay_test_1");
    expect(await currentPlanKey(fixture.companyId)).toBe(plan.key);
  }, 120_000);

  it("applies once, however many times it is delivered", async () => {
    // Providers retry deliveries on purpose. A second delivery must not raise a
    // second invoice, and must not be reported as an error.
    const { fixture, plan, session } = await openCheckout(
      `order_paid2_${uniqueSlug("o")}`,
    );
    const hook = capturedWebhook({
      orderId: session.orderId,
      amountMinor: plan.priceMinor,
    });

    // Deliberately the same id twice — that is what a redelivery looks like.
    const eventId = evt("dup");
    const first = await handleRazorpayWebhook({ ...hook, eventId });
    const second = await handleRazorpayWebhook({ ...hook, eventId });

    expect(first.handled).toBe(true);
    expect(second).toMatchObject({ handled: true, outcome: "DUPLICATE" });

    const events = await prisma.paymentEvent.count({ where: { eventId } });
    expect(events).toBe(1);
    expect(await currentPlanKey(fixture.companyId)).toBe(plan.key);
  }, 120_000);

  it("refuses a payment for less than the invoice, and grants nothing", async () => {
    // The attack: open a checkout for the ₹4,999 plan, pay ₹1, and see whether
    // the webhook upgrades you anyway.
    const { fixture, plan, session } = await openCheckout(
      `order_short_${uniqueSlug("o")}`,
    );
    const hook = capturedWebhook({
      orderId: session.orderId,
      amountMinor: 100,
    });

    const result = await handleRazorpayWebhook({
      ...hook,
      eventId: evt("short"),
    });

    expect(result).toMatchObject({ outcome: "AMOUNT_MISMATCH" });
    const invoice = await prisma.subscriptionInvoice.findUniqueOrThrow({
      where: { id: session.invoiceId },
      select: { status: true, failureReason: true },
    });
    expect(invoice.status).toBe("FAILED");
    expect(invoice.failureReason).toMatch(/expected/i);
    expect(await currentPlanKey(fixture.companyId)).not.toBe(plan.key);
  }, 120_000);

  it("refuses a payment in another currency", async () => {
    const { fixture, plan, session } = await openCheckout(
      `order_currency_${uniqueSlug("o")}`,
    );
    const hook = capturedWebhook({
      orderId: session.orderId,
      amountMinor: plan.priceMinor,
      currency: "USD",
    });

    const result = await handleRazorpayWebhook({
      ...hook,
      eventId: evt("currency"),
    });

    expect(result).toMatchObject({ outcome: "AMOUNT_MISMATCH" });
    expect(await currentPlanKey(fixture.companyId)).not.toBe(plan.key);
  }, 120_000);

  it("does not treat an authorised-but-uncaptured payment as paid", async () => {
    // "authorized" is a hold that can still expire. Granting a plan against it
    // would give away a month for money that never arrives.
    const { fixture, plan, session } = await openCheckout(
      `order_authorized_${uniqueSlug("o")}`,
    );
    const hook = capturedWebhook({
      orderId: session.orderId,
      amountMinor: plan.priceMinor,
      status: "authorized",
    });

    const result = await handleRazorpayWebhook({
      ...hook,
      eventId: evt("authorized"),
    });

    expect(result).toMatchObject({ outcome: "NOT_CAPTURED" });
    const invoice = await prisma.subscriptionInvoice.findUniqueOrThrow({
      where: { id: session.invoiceId },
      select: { status: true },
    });
    expect(invoice.status).toBe("PENDING");
    expect(await currentPlanKey(fixture.companyId)).not.toBe(plan.key);
  }, 120_000);

  it("ignores a payment for an order it never created", async () => {
    const result = await handleRazorpayWebhook({
      ...capturedWebhook({ orderId: "order_never_seen", amountMinor: 100 }),
      eventId: evt("unknown_order"),
    });
    expect(result).toMatchObject({ outcome: "UNKNOWN_ORDER" });
  }, 60_000);
});

describe("a webhook that cannot be trusted", () => {
  it("refuses an unsigned body without reading it for meaning", async () => {
    const { rawBody } = capturedWebhook({
      orderId: "order_forged",
      amountMinor: 999_999,
    });

    const result = await handleRazorpayWebhook({
      rawBody,
      signature: null,
      eventId: evt("unsigned"),
    });

    expect(result).toMatchObject({ handled: false, status: 400 });
  }, 60_000);

  it("refuses a body edited after it was signed", async () => {
    // A real captured-payment webhook, replayed with the amount changed.
    const hook = capturedWebhook({
      orderId: "order_tampered",
      amountMinor: 100,
    });
    const tampered = hook.rawBody.replace('"amount":100', '"amount":499900');

    const result = await handleRazorpayWebhook({
      rawBody: tampered,
      signature: hook.signature,
      eventId: evt("tampered"),
    });

    expect(result).toMatchObject({ handled: false, outcome: "BAD_SIGNATURE" });
  }, 60_000);

  it("keeps the rejected attempt, because a run of them is worth seeing", async () => {
    const hook = capturedWebhook({ orderId: "order_probe", amountMinor: 1 });
    const eventId = evt("probe");
    await handleRazorpayWebhook({
      rawBody: hook.rawBody,
      signature: "0".repeat(64),
      eventId,
    });

    const event = await prisma.paymentEvent.findFirstOrThrow({
      where: { eventId },
      select: { signatureVerified: true, outcome: true, payload: true },
    });
    expect(event.signatureVerified).toBe(false);
    expect(event.outcome).toBe("BAD_SIGNATURE");
    // Stored as text, not as structured data: it did not come from the provider.
    expect(event.payload).toHaveProperty("unverified");
  }, 60_000);

  it("cannot be replayed against a different company's invoice", async () => {
    // Two companies, each with an open checkout. A signed webhook naming one
    // order must never touch the other's invoice.
    const [a, b] = await Promise.all([createCompany(), createCompany()]);
    await Promise.all([putOnFreePlan(a.companyId), putOnFreePlan(b.companyId)]);
    const plan = await paidPlan();

    const sessionA = await startPlanUpgrade({
      companyId: a.companyId,
      planKey: plan.key,
      userId: a.userId,
      actorEmail: a.email,
      userName: "A",
      transport: fakeTransport([orderResponse(plan.priceMinor, "order_a")])
        .transport,
    });
    const sessionB = await startPlanUpgrade({
      companyId: b.companyId,
      planKey: plan.key,
      userId: b.userId,
      actorEmail: b.email,
      userName: "B",
      transport: fakeTransport([orderResponse(plan.priceMinor, "order_b")])
        .transport,
    });

    await handleRazorpayWebhook({
      ...capturedWebhook({ orderId: "order_a", amountMinor: plan.priceMinor }),
      eventId: evt("only_a"),
    });

    const invoiceA = await prisma.subscriptionInvoice.findUniqueOrThrow({
      where: { id: sessionA.invoiceId },
      select: { status: true },
    });
    const invoiceB = await prisma.subscriptionInvoice.findUniqueOrThrow({
      where: { id: sessionB.invoiceId },
      select: { status: true },
    });

    expect(invoiceA.status).toBe("PAID");
    expect(invoiceB.status).toBe("PENDING");
    expect(await currentPlanKey(a.companyId)).toBe(plan.key);
    expect(await currentPlanKey(b.companyId)).not.toBe(plan.key);
  }, 150_000);
});

describe("a webhook saying the payment failed", () => {
  it("records the reason and leaves the plan alone", async () => {
    const fixture = await createCompany();
    await putOnFreePlan(fixture.companyId);
    const plan = await paidPlan();
    const before = await currentPlanKey(fixture.companyId);
    const session = await startPlanUpgrade({
      companyId: fixture.companyId,
      planKey: plan.key,
      userId: fixture.userId,
      actorEmail: fixture.email,
      userName: "Ravi Prakash",
      transport: fakeTransport([orderResponse(plan.priceMinor, "order_failed")])
        .transport,
    });

    const body = JSON.stringify({
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            id: "pay_failed",
            order_id: session.orderId,
            amount: plan.priceMinor,
            currency: "INR",
            status: "failed",
            error_description: "Payment declined by the bank",
          },
        },
      },
    });

    await handleRazorpayWebhook({
      rawBody: body,
      signature: createHmac("sha256", WEBHOOK_SECRET)
        .update(body, "utf8")
        .digest("hex"),
      eventId: evt("failed"),
    });

    const invoice = await prisma.subscriptionInvoice.findUniqueOrThrow({
      where: { id: session.invoiceId },
      select: { status: true, failureReason: true },
    });
    expect(invoice.status).toBe("FAILED");
    expect(invoice.failureReason).toBe("Payment declined by the bank");
    expect(await currentPlanKey(fixture.companyId)).toBe(before);
  }, 120_000);
});

describe("the record of what the provider said", () => {
  it("cannot be edited after the fact", async () => {
    // The table is evidence about money. An UPDATE that rewrites what arrived
    // is refused by the database, not merely avoided by the code.
    const hook = capturedWebhook({
      orderId: "order_immutable",
      amountMinor: 1,
    });
    const eventId = evt("immutable");
    await handleRazorpayWebhook({ ...hook, eventId });

    await expect(
      prisma.paymentEvent.updateMany({
        where: { eventId },
        data: { payload: { rewritten: true } },
      }),
    ).rejects.toThrow(/append-only/i);
  }, 60_000);

  it("cannot be deleted", async () => {
    const hook = capturedWebhook({
      orderId: "order_undeletable",
      amountMinor: 1,
    });
    const eventId = evt("undeletable");
    await handleRazorpayWebhook({ ...hook, eventId });

    await expect(
      prisma.paymentEvent.deleteMany({ where: { eventId } }),
    ).rejects.toThrow(/append-only/i);
  }, 60_000);
});
