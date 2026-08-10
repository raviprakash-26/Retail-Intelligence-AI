import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/shell/module-placeholder";
import { requirePermission } from "@/server/auth/context";

export const metadata: Metadata = {
  title: "AI Accountant",
  robots: { index: false, follow: false },
};

export default async function AiAccountantPage() {
  await requirePermission("ai.accountant");

  return (
    <ModulePlaceholder
      title="AI Accountant"
      icon="MessageSquareText"
      phase={20}
      description="Ask about your business in plain language and get an answer built from your ledger."
      willInclude={[
        "Natural-language questions about your own figures",
        "Answers cite the period, the figures and the source report",
        "Reads through defined queries — it cannot invent a number",
        "Conversation history you can return to",
      ]}
    />
  );
}
