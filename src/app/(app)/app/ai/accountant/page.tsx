import type { Metadata } from "next";
import { AccountantChat } from "@/components/ai/accountant-chat";
import { MasterDataHeader } from "@/components/master-data/page-header";
import { FEATURE } from "@/lib/billing/plans";
import { PlanLocked } from "@/components/billing/plan-locked";
import { featureGate } from "@/server/billing/guards";
import { requirePermission } from "@/server/auth/context";
import { providerStatus } from "@/server/ai/provider";
import { resolveConversation } from "@/server/ai/accountant";

export const metadata: Metadata = {
  title: "AI Accountant",
  robots: { index: false, follow: false },
};

/**
 * The AI Accountant.
 *
 * The assistant answers from the same reports the rest of the product shows,
 * through a fixed set of read-only queries bound to this tenant. It computes
 * nothing itself, it can change nothing, and every answer carries the queries
 * that produced it.
 */
export default async function AccountantPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await requirePermission("ai.accountant");

  // The navigation marks this when a plan does not include it, but marking is
  // presentation. Anybody can type the URL, so the page asks as well.
  const gate = await featureGate(context.company.id, FEATURE.AI_ACCOUNTANT);
  if (!gate.included) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
        <PlanLocked
          feature={FEATURE.AI_ACCOUNTANT}
          planName={gate.entitlements.planName}
          availableOn={gate.availableOn}
        />
      </div>
    );
  }
  const params = await searchParams;

  const requested = params.conversation;
  const conversationId = Array.isArray(requested) ? requested[0] : requested;

  // Only a conversation belonging to this company *and* this user resolves.
  const conversation = await resolveConversation({
    companyId: context.company.id,
    userId: context.user.id,
    conversationId: conversationId ?? null,
  });

  const status = providerStatus();

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <MasterDataHeader
        title="AI Accountant"
        description="Ask about your books in plain words. Every figure it quotes is read from the same reports you can open yourself — it does no arithmetic of its own, and it cannot change anything."
      />

      <AccountantChat
        conversationId={conversation?.id ?? null}
        messages={conversation?.messages ?? []}
        suggestions={[
          "How much did I make this year?",
          "Who owes me money?",
          "What is running low in stock?",
          "What would my GST come to for last month?",
        ]}
        available={status.available}
        unavailableReason={status.available ? null : status.reason}
      />
    </div>
  );
}
