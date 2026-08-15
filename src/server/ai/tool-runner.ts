import "server-only";
import { TOOLS, isToolName, type ToolName } from "@/lib/ai/tools";
import {
  getChartOfAccounts,
  type ChartOfAccounts,
} from "@/server/accounting/account-service";
import { getFinancialStatements } from "@/server/accounting/statements-service";
import { getTrialBalance } from "@/server/accounting/trial-balance-service";
import { getAnalytics } from "@/server/analytics/analytics-service";
import { getForecast } from "@/server/forecast/forecast-service";
import { getGstWorkingPaper } from "@/server/gst/gst-return-service";
import { getStockSummary } from "@/server/inventory/inventory-report";
import {
  payablesAgeing,
  receivablesAgeing,
} from "@/server/settlements/outstanding";
import { getTaxWorkingPaper } from "@/server/tax/income-tax-service";

/**
 * Running a tool the model asked for, against exactly one tenant.
 *
 * **The company is bound here and nowhere else.** It comes from the session,
 * through this closure, into every service call. No tool schema accepts a
 * company identifier, so there is no field for a model to put one in — a
 * hallucinated tenant id has nowhere to go, and a prompt injection asking for
 * "the figures for Sharma Traders" gets this business's figures or an error,
 * never somebody else's.
 *
 * Nothing here writes. Every entry in the catalogue is a read, and the runner
 * asserts that before dispatching rather than trusting the catalogue.
 *
 * Failures come back as values rather than thrown: the model needs to be told
 * "that period has no data" so it can say so, and an exception escaping into
 * the conversation loop would lose the turn instead.
 */

export type ToolContext = {
  companyId: string;
  fiscalYearStart: Date | null;
  fiscalYearEnd: Date | null;
};

export type ToolOutcome =
  { ok: true; result: unknown } | { ok: false; error: string };

export async function runTool(params: {
  name: string;
  input: unknown;
  context: ToolContext;
}): Promise<ToolOutcome> {
  if (!isToolName(params.name)) {
    return {
      ok: false,
      error: `There is no tool called "${params.name}". Use one of the tools you were given.`,
    };
  }

  const definition = TOOLS[params.name];
  if (!definition.readOnly) {
    // Unreachable while the catalogue holds, which is the point: adding a tool
    // that writes has to get past this line as well as past the type.
    return {
      ok: false,
      error: "That tool would change records, which is not allowed here.",
    };
  }

  const parsed = definition.input.safeParse(params.input ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: `Those arguments are not valid${first ? `: ${first.path.join(".") || "input"} — ${first.message}` : "."}`,
    };
  }

  try {
    const result = await dispatch(
      params.name,
      parsed.data as Record<string, unknown>,
      params.context,
    );
    return { ok: true, result };
  } catch (error) {
    // The message, not the stack: the model is going to read this, and a stack
    // trace in a chat window helps nobody and leaks shapes it should not see.
    return {
      ok: false,
      error:
        error instanceof Error
          ? `That could not be worked out: ${error.message}`
          : "That could not be worked out.",
    };
  }
}

async function dispatch(
  name: ToolName,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<unknown> {
  const { companyId } = context;

  switch (name) {
    case "financial_statements":
      return getFinancialStatements({
        companyId,
        from: input.from as string,
        to: input.to as string,
      });

    case "trial_balance":
      return getTrialBalance({ companyId, to: input.to as string });

    case "chart_of_accounts":
      return chartForModel(await getChartOfAccounts({ companyId }));

    case "outstanding":
      return input.kind === "payable"
        ? payablesAgeing(companyId)
        : receivablesAgeing(companyId);

    case "stock_position":
      return getStockSummary({
        companyId,
        query: (input.search as string | undefined) ?? "",
        filter: input.filter as "low" | "out" | undefined,
        // Rows come back a page at a time. Without this the model could see
        // only ever the first page — a shop with forty lines out of stock had
        // fifteen of them permanently unreachable, and nothing said so.
        page: input.page as number | undefined,
      });

    case "gst_working_paper":
      return getGstWorkingPaper({
        companyId,
        year: input.year as number,
        month: input.month as number,
      });

    case "income_tax_estimate": {
      const year = await currentFiscalYearId(context);
      if (!year) {
        throw new Error("no financial year has been set up for this business");
      }
      return getTaxWorkingPaper({ companyId, fiscalYearId: year });
    }

    case "analytics": {
      if (!context.fiscalYearStart || !context.fiscalYearEnd) {
        throw new Error("no financial year has been set up for this business");
      }
      return getAnalytics({
        companyId,
        range: input.range as "fy" | "90d" | "30d",
        fiscalYearStart: context.fiscalYearStart,
        fiscalYearEnd: context.fiscalYearEnd,
      });
    }

    case "forecast":
      return getForecast({ companyId });
  }
}

/**
 * The chart, in the shape the question needs.
 *
 * Selection, not computation: every field here is copied from what the service
 * returned, and no figure is recalculated on the way through. That distinction
 * is the whole rule this module is built on, and a projection does not break
 * it — the balance beside an account is still the balance the statements read.
 *
 * The page's own structure was being sent whole, and it was by far the most
 * expensive thing the assistant could ask for: 49KB on a demo shop with 57
 * accounts, six times every other tool put together. Most of it was not usable.
 * `tree` and `accounts` are the same accounts twice over, once nested and once
 * flat. Every account carried a UUID, and no tool in the catalogue accepts an
 * account id, so the model was reading two thousand characters of identifier it
 * had nowhere to use. `sortOrder` and `isSystem` describe how the page draws
 * itself.
 *
 * That cost is not paid once. A tool result stays in the conversation and is
 * sent again with every later turn, uncached — so a shopkeeper asking three
 * follow-up questions paid for the whole chart three times.
 *
 * What is kept is what answers "which account does this belong in" and "what
 * does this account hold": the code, the name, the group it sits under, and the
 * balance. Inactive accounts are dropped — nothing can be posted to them, so
 * they cannot be the answer to either question.
 */
function chartForModel(chart: ChartOfAccounts): {
  accounts: Array<{
    code: string;
    name: string;
    group: string;
    type: string;
    balance: string;
  }>;
  note: string;
} {
  const groupName = new Map(
    chart.groups.map((group) => [group.id, group.name]),
  );

  return {
    accounts: chart.accounts
      .filter((account) => account.isActive)
      .map((account) => ({
        code: account.code,
        name: account.name,
        group: groupName.get(account.groupId) ?? account.type,
        type: account.type,
        balance: account.balance,
      })),
    note: "Balances are signed in the direction of each account's nature, as at today.",
  };
}

/**
 * The fiscal year the tax estimate runs on.
 *
 * Resolved from the bound context rather than from anything the model said, so
 * "prepare the tax computation for Sharma Traders" cannot reach another
 * tenant's year even if the model tries to pass one.
 */
async function currentFiscalYearId(
  context: ToolContext,
): Promise<string | null> {
  if (!context.fiscalYearStart) return null;
  const { prisma } = await import("@/lib/db");
  const year = await prisma.fiscalYear.findFirst({
    where: {
      companyId: context.companyId,
      startDate: context.fiscalYearStart,
    },
    select: { id: true },
  });
  return year?.id ?? null;
}

/** A short, readable note of what a tool was asked, for the transcript. */
export function describeToolCall(name: string, input: unknown): string {
  const record = (input ?? {}) as Record<string, unknown>;
  const parts = Object.entries(record)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}: ${String(value)}`);
  return parts.length > 0 ? `${name} (${parts.join(", ")})` : name;
}
