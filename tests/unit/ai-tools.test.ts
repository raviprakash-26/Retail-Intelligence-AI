import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  isToolName,
  TOOL_NAMES,
  TOOLS,
  toolList,
  toolSchemas,
} from "@/lib/ai/tools";
import {
  PROMPT_RULES,
  statesUnverifiedFigures,
  systemPrompt,
} from "@/lib/ai/prompt";

/**
 * The guarantees around the assistant.
 *
 * None of these test what a model says, because none of the guarantees depend
 * on what a model says. They test that the model is structurally unable to
 * reach another tenant, structurally unable to change anything, and that an
 * answer quoting a figure with nothing behind it gets marked before a person
 * reads it.
 */

describe("no tool can reach another business", () => {
  it("gives no tool a company field to put an identifier in", () => {
    // The tenant is bound by the runner from the session. A model that
    // hallucinated another company's id would have nowhere to put it.
    for (const tool of toolList()) {
      const schema = z.toJSONSchema(tool.input, { io: "input" }) as {
        properties?: Record<string, unknown>;
      };
      const keys = Object.keys(schema.properties ?? {});
      for (const key of keys) {
        expect(key.toLowerCase()).not.toMatch(
          /company|tenant|organisation|org/,
        );
      }
    }
  });

  it("keeps that true of every nested field too", () => {
    for (const tool of toolList()) {
      const json = JSON.stringify(
        z.toJSONSchema(tool.input, { io: "input" }),
      ).toLowerCase();
      expect(json).not.toContain("companyid");
      expect(json).not.toContain("tenantid");
    }
  });
});

describe("no tool can change anything", () => {
  it("marks every tool read-only", () => {
    for (const tool of toolList()) {
      expect(tool.readOnly).toBe(true);
    }
  });

  it("has no tool whose name suggests it writes", () => {
    // A cheap tripwire: the day somebody adds `post_journal_entry` to this
    // catalogue, this fails before the runner ever sees it.
    for (const name of TOOL_NAMES) {
      expect(name).not.toMatch(
        /create|post|update|delete|void|edit|write|set_|remove/,
      );
    }
  });
});

describe("the catalogue", () => {
  it("exposes every named tool, and nothing else", () => {
    expect(toolList()).toHaveLength(TOOL_NAMES.length);
    for (const name of TOOL_NAMES) {
      expect(TOOLS[name].name).toBe(name);
    }
  });

  it("recognises its own names and refuses others", () => {
    expect(isToolName("trial_balance")).toBe(true);
    expect(isToolName("drop_tables")).toBe(false);
    expect(isToolName("")).toBe(false);
  });

  it("describes each tool well enough for a model to choose it", () => {
    for (const tool of toolList()) {
      expect(tool.description.length).toBeGreaterThan(60);
    }
  });

  it("generates schemas from the same shapes the runner validates", () => {
    // The contract the model is shown and the contract the runner enforces come
    // from one Zod schema, so they cannot drift apart.
    const schemas = toolSchemas();
    expect(schemas).toHaveLength(TOOL_NAMES.length);
    for (const schema of schemas) {
      expect(schema.input_schema).toHaveProperty("type", "object");
      expect(schema.description.length).toBeGreaterThan(60);
    }
  });

  it("tells the model what it must not conclude, not only what it returns", () => {
    // The GST and tax tools carry their framing into the model's context, so a
    // careless answer has to ignore an instruction rather than never see one.
    expect(TOOLS.gst_working_paper.description).toMatch(
      /never say a return has been filed/i,
    );
    expect(TOOLS.income_tax_estimate.description).toMatch(
      /estimate, not advice/i,
    );
    expect(TOOLS.forecast.description).toMatch(/never as a prediction/i);
    expect(TOOLS.analytics.description).toMatch(/never a zero/i);
  });
});

describe("validating what the model sends", () => {
  const parse = (name: keyof typeof TOOLS, input: unknown) =>
    TOOLS[name].input.safeParse(input);

  it("accepts well-formed arguments", () => {
    expect(
      parse("financial_statements", { from: "2026-04-01", to: "2026-06-30" })
        .success,
    ).toBe(true);
    expect(parse("outstanding", { kind: "payable" }).success).toBe(true);
    expect(parse("gst_working_paper", { year: 2026, month: 6 }).success).toBe(
      true,
    );
  });

  it("rejects a date that is not a real date", () => {
    // The same calendar check every form in the product uses.
    expect(
      parse("financial_statements", { from: "2026-02-30", to: "2026-06-30" })
        .success,
    ).toBe(false);
  });

  it("rejects a month that does not exist", () => {
    expect(parse("gst_working_paper", { year: 2026, month: 13 }).success).toBe(
      false,
    );
    expect(parse("gst_working_paper", { year: 2026, month: 0 }).success).toBe(
      false,
    );
  });

  it("rejects an option outside the ones offered", () => {
    expect(parse("outstanding", { kind: "everything" }).success).toBe(false);
    expect(parse("analytics", { range: "5y" }).success).toBe(false);
  });

  it("takes no arguments where none are needed", () => {
    expect(parse("chart_of_accounts", {}).success).toBe(true);
    expect(parse("forecast", {}).success).toBe(true);
  });
});

describe("the system prompt", () => {
  const prompt = systemPrompt({
    businessName: "Ravi Retail Mart",
    today: "2026-08-12",
    fiscalYearLabel: "2026-27",
    fiscalYearFrom: "2026-04-01",
    fiscalYearTo: "2027-03-31",
    currency: "INR",
  });

  it("keeps every rule that must survive an edit", () => {
    // A prompt that quietly loses its "you do not calculate" line is the kind
    // of regression that ships without anybody noticing.
    for (const rule of Object.values(PROMPT_RULES)) {
      expect(prompt).toContain(rule);
    }
  });

  it("tells the assistant where a change would have to be made instead", () => {
    // Refusing to post something is only useful with the next step attached.
    expect(prompt).toContain("/app/sales/new");
    expect(prompt).toContain("/app/accounting/journal");
  });

  it("carries the business and the year so relative questions resolve", () => {
    expect(prompt).toContain("Ravi Retail Mart");
    expect(prompt).toContain("2026-08-12");
    expect(prompt).toContain("2026-04-01");
  });

  it("says so plainly when no year has been set up", () => {
    const bare = systemPrompt({
      businessName: "New Shop",
      today: "2026-08-12",
      fiscalYearLabel: null,
      fiscalYearFrom: null,
      fiscalYearTo: null,
      currency: "INR",
    });
    expect(bare).toMatch(/No financial year has been set up yet/);
  });

  it("insists that nothing here has been filed", () => {
    expect(prompt).toMatch(/nothing in it can file/i);
  });
});

describe("marking a figure nothing was asked for", () => {
  it("flags an answer that states money with no tool behind it", () => {
    // By construction this is a number the model produced from its own head.
    expect(statesUnverifiedFigures("Your revenue was ₹4,20,000.", 0)).toBe(
      true,
    );
    expect(statesUnverifiedFigures("About 15,000.50 in total.", 0)).toBe(true);
    expect(statesUnverifiedFigures("Roughly ninety thousand rupees.", 0)).toBe(
      true,
    );
  });

  it("does not flag the same answer when a tool was called", () => {
    expect(statesUnverifiedFigures("Your revenue was ₹4,20,000.", 1)).toBe(
      false,
    );
  });

  it("does not flag an answer that states no money at all", () => {
    expect(
      statesUnverifiedFigures(
        "I cannot post that for you. Use the sales page.",
        0,
      ),
    ).toBe(false);
    expect(statesUnverifiedFigures("There were 4 invoices last week.", 0)).toBe(
      false,
    );
  });
});
