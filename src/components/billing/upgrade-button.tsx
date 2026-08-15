"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { startPlanUpgradeAction } from "@/server/billing/actions";
import type { CheckoutSession } from "@/server/billing/checkout";

/**
 * Paying for an upgrade.
 *
 * The payment form is Razorpay's, in their iframe, on their domain. No card
 * number, expiry or CVV ever reaches this application — which is the entire
 * reason for using a gateway, and the reason the CSP is widened only where one
 * is configured.
 *
 * What this component must not do is decide anything. When the widget's handler
 * fires, all that is known is that the browser was told the payment went
 * through — and a browser can be lied to, or can close before saying anything.
 * So the message is deliberately about what is happening rather than what has
 * been granted, and the plan on the page changes only after the server has been
 * told by the provider, over a signed channel.
 */

const SCRIPT_SRC = "https://checkout.razorpay.com/v1/checkout.js";

type RazorpayHandlerResponse = {
  razorpay_payment_id?: string;
  razorpay_order_id?: string;
  razorpay_signature?: string;
};

type RazorpayOptions = {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  prefill: { name: string; email: string };
  handler: (response: RazorpayHandlerResponse) => void;
  modal: { ondismiss: () => void };
  theme?: { color: string };
};

type RazorpayConstructor = new (options: RazorpayOptions) => {
  open: () => void;
  on: (event: string, handler: (payload: unknown) => void) => void;
};

declare global {
  interface Window {
    Razorpay?: RazorpayConstructor;
  }
}

/** Loads the provider's script once, and reuses it afterwards. */
function loadCheckoutScript(): Promise<RazorpayConstructor> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Not in a browser."));
  }
  if (window.Razorpay) return Promise.resolve(window.Razorpay);

  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${SCRIPT_SRC}"]`,
    );
    const script = existing ?? document.createElement("script");

    const onLoad = () => {
      if (window.Razorpay) resolve(window.Razorpay);
      else reject(new Error("The payment form loaded but did not start."));
    };

    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener(
      "error",
      () =>
        reject(
          new Error(
            "The payment form could not be loaded. Check the connection and try again.",
          ),
        ),
      { once: true },
    );

    if (!existing) {
      script.src = SCRIPT_SRC;
      script.async = true;
      document.body.appendChild(script);
    }
  });
}

export function UpgradeButton({
  planKey,
  planName,
  disabled,
  onBusyChange,
  onNotice,
  onError,
}: {
  planKey: string;
  planName: string;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);

  const busy = (value: boolean) => {
    setPending(value);
    onBusyChange(value);
  };

  async function open(session: CheckoutSession) {
    const Razorpay = await loadCheckoutScript();

    const checkout = new Razorpay({
      key: session.keyId,
      order_id: session.orderId,
      amount: session.amountMinor,
      currency: session.currency,
      name: session.businessName,
      description: session.description,
      prefill: session.prefill,
      handler: () => {
        // Note what is *not* said here: not "you are on the new plan". The
        // browser has been told the payment succeeded, which is not the same
        // as the money having reached the merchant account. The plan moves
        // when the provider tells the server so.
        busy(false);
        onNotice(
          "Payment submitted. Your plan updates as soon as the payment is confirmed — usually within a few seconds. Refresh this page to check.",
        );
        router.refresh();
      },
      modal: {
        ondismiss: () => {
          busy(false);
          onNotice("Payment cancelled. Nothing has been charged.");
        },
      },
    });

    checkout.on("payment.failed", () => {
      busy(false);
      onError(
        "That payment did not go through, so nothing has been charged and your plan is unchanged.",
      );
    });

    checkout.open();
  }

  return (
    <Button
      size="sm"
      disabled={disabled || pending}
      onClick={() => {
        busy(true);
        onError("");
        void (async () => {
          try {
            const result = await startPlanUpgradeAction(planKey);
            if (!result.ok) {
              busy(false);
              onError(result.message);
              return;
            }
            await open(result.data);
          } catch (error) {
            busy(false);
            onError(
              error instanceof Error
                ? `${error.message} Nothing has been charged.`
                : "The payment could not be started. Nothing has been charged.",
            );
          }
        })();
      }}
    >
      {pending ? <Loader2 className="size-4 animate-spin" /> : null}
      Pay and move to {planName}
    </Button>
  );
}
