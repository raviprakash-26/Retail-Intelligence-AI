import { z } from "zod";
import { isoDate } from "@/lib/validation/date";

/**
 * What the AI Accountant is allowed to ask for.
 *
 * Three rules hold this module together, and each is enforced by structure
 * rather than by hoping a prompt is obeyed.
 *
 * **No tool computes anything.** Every one of these is a thin wrapper over a
 * service that already exists — the same balance engine the statements read,
 * the same GST working paper the GST page shows. The model never does
 * arithmetic on financial data, because it is never in a position to: it asks
 * a question and receives an answer that was computed by application code.
 *
 * **No tool takes a company.** Not one input schema here has a `companyId`,
 * and there is a test that fails if one ever appears. The tenant is bound by
 * the runner from the session, so a model that hallucinated another business's
 * identifier would have nowhere to put it.
 *
 * **No tool writes.** Every entry is marked read-only and a test asserts it.
 * The assistant cannot post, void, edit or delete anything; when asked to, it
 * says so and points at the form that can.
 */

export const TOOL_NAMES = [
  "financial_statements",
  "trial_balance",
  "chart_of_accounts",
  "outstanding",
  "stock_position",
  "gst_working_paper",
  "income_tax_estimate",
  "analytics",
  "forecast",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export type ToolDefinition = {
  name: ToolName;
  /** What the model is told this does, and what it must not conclude from it. */
  description: string;
  input: z.ZodType;
  /**
   * Always true. The field exists so the runner can assert it and so a future
   * tool that writes cannot be added here without the assertion failing.
   */
  readOnly: true;
};

const period = z.object({
  from: isoDate.describe("First day of the period, YYYY-MM-DD."),
  to: isoDate.describe("Last day of the period, YYYY-MM-DD."),
});

export const TOOLS: Record<ToolName, ToolDefinition> = {
  financial_statements: {
    name: "financial_statements",
    description:
      "The trading account, profit and loss account and balance sheet for a period, computed from posted entries. Use this for revenue, cost of sales, gross profit, expenses, net profit, assets, liabilities and capital. Do not add these figures up yourself — they are already totalled.",
    input: period,
    readOnly: true,
  },
  trial_balance: {
    name: "trial_balance",
    description:
      "Every account with a balance, in debit and credit columns, with the totals and whether they agree. Balancing proves the arithmetic holds, not that the books are right — a purchase recorded against Rent balances perfectly and is still wrong.",
    input: z.object({
      to: isoDate.describe("The date to draw the balance at, YYYY-MM-DD."),
    }),
    readOnly: true,
  },
  chart_of_accounts: {
    name: "chart_of_accounts",
    description:
      "Every account the books can post to, grouped, with what each currently holds. Use this to find out which account something belongs in, or what an account is called.",
    input: z.object({}),
    readOnly: true,
  },
  outstanding: {
    name: "outstanding",
    description:
      "Who owes the business money and whom the business owes, aged from each document's due date. 'receivable' is money coming in, 'payable' is money going out.",
    input: z.object({
      kind: z
        .enum(["receivable", "payable"])
        .describe("Which side of the ledger to age."),
    }),
    readOnly: true,
  },
  stock_position: {
    name: "stock_position",
    description:
      "What is on the shelves, at what it cost, with what has run out or is running low. Optionally narrowed to products matching a search. Rows come back one page at a time: `total` is how many match, `page` is which one you were given and `pageCount` how many there are. Never state or count rows as if they were all of them — say how many matched, and ask for the next page if the question needs it. The summary figures are for the whole business and do not change with the page.",
    input: z.object({
      search: z
        .string()
        .trim()
        .max(80)
        .optional()
        .describe("Part of a product name or SKU."),
      filter: z
        .enum(["low", "out"])
        .optional()
        .describe("Narrow to stock that is low, or that has run out."),
      page: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Which page of rows to return. Defaults to the first."),
    }),
    readOnly: true,
  },
  gst_working_paper: {
    name: "gst_working_paper",
    description:
      "The GST preparation for one month: tax on sales, credit on purchases, the set-off in the order the law prescribes, and what would be payable. This is a working paper prepared for review. It has not been filed and nothing can file it, so never say a return has been filed or submitted.",
    input: z.object({
      year: z.number().int().min(2000).max(2100),
      month: z.number().int().min(1).max(12),
    }),
    readOnly: true,
  },
  income_tax_estimate: {
    name: "income_tax_estimate",
    description:
      "An estimate of income tax on the year's business income, with the adjustments between book profit and taxable income and the items that need a human decision. It is an estimate, not advice, and it cannot see income from anywhere but this business — say so whenever you quote it.",
    input: z.object({}),
    readOnly: true,
  },
  analytics: {
    name: "analytics",
    description:
      "Revenue and profit over time, which products and customers earn, the shape of the week, and the ratios with their meanings. Ratios that could not be computed come back as null with a reason — report the reason, never a zero.",
    input: z.object({
      range: z.enum(["fy", "90d", "30d"]).describe("The period to report on."),
    }),
    readOnly: true,
  },
  forecast: {
    name: "forecast",
    description:
      "The revenue projection as a range with its band, and the cash weeks ahead from commitments that already exist. Always quote the range, never the middle of it, and never as a prediction of what will happen.",
    input: z.object({}),
    readOnly: true,
  },
};

export function toolList(): ToolDefinition[] {
  return TOOL_NAMES.map((name) => TOOLS[name]);
}

/**
 * The tool catalogue in the shape a model provider expects.
 *
 * JSON Schema is generated from the same Zod schema the runner validates
 * against, so the contract the model is shown and the contract the runner
 * enforces cannot drift apart.
 */
export function toolSchemas(): Array<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}> {
  return toolList().map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: z.toJSONSchema(tool.input, { io: "input" }) as Record<
      string,
      unknown
    >,
  }));
}

export function isToolName(value: string): value is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(value);
}

/** What a tool call and its answer look like once recorded against a message. */
export type ToolInvocation = {
  name: string;
  input: unknown;
  ok: boolean;
  /** Present when the call succeeded. */
  result?: unknown;
  /** Present when it did not, in words the model can act on. */
  error?: string;
  latencyMs: number;
};
