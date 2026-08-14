import { describe, expect, it } from "vitest";
import {
  ADVISOR_DISCLAIMER,
  CATALOGUE_VERSION,
  PROFESSIONAL_NOTE,
  PROMISE_WORDS,
  promises,
  RULES,
  SUGGESTION_KEYS,
  ruleList,
} from "@/lib/advisor/catalogue";
import {
  estimated,
  ESTIMATE_SPREAD_PERCENT,
  MATERIAL_SHARE_PERCENT,
  rank,
  rankingAmount,
  recorded,
  unquantified,
  urgencyFor,
  type Suggestion,
} from "@/lib/advisor/impact";

/**
 * What the advisor is allowed to say.
 *
 * It is reading one shop's books and nothing else. It has not met the
 * customers, does not know which supplier is reliable, and cannot tell a
 * deliberate quiet month from a bad one. Everything here protects the gap
 * between "your books show this" and "do this and you will earn more".
 */

describe("the advisor promises nothing", () => {
  it("uses none of the words that promise an outcome", () => {
    for (const rule of ruleList()) {
      const text = [
        rule.title,
        rule.whatToDo,
        rule.basis,
        ...rule.whenThisDoesNotApply,
      ].join(" ");

      expect(promises(text), `${rule.key} promises an outcome`).toBe(false);
      expect(PROMISE_WORDS.length).toBeGreaterThan(10);
    }
  });

  it("recognises a promise when it sees one", () => {
    expect(promises("This will increase your profit.")).toBe(true);
    expect(promises("A GUARANTEED saving.")).toBe(true);
    expect(promises("Four invoices are past their due date.")).toBe(false);
  });

  it("reads whole words, so an ordinary sentence is not a promise", () => {
    // A shop whose stock turns faster than its suppliers' credit can run below
    // a current ratio of one indefinitely. That contains "definitely" and
    // promises nobody anything.
    expect(promises("A healthy shop can run below one indefinitely.")).toBe(
      false,
    );
    expect(promises("Margins will increase.")).toBe(true);
  });

  it("says out loud that it is not advice", () => {
    expect(ADVISOR_DISCLAIMER).toMatch(/not financial, tax or legal advice/i);
    // The most important sentence in the product: the reader is allowed to
    // disagree with it.
    expect(ADVISOR_DISCLAIMER).toMatch(/right to ignore/i);
  });
});

describe("every suggestion carries the case against itself", () => {
  it("says when it does not apply, at length", () => {
    for (const rule of ruleList()) {
      expect(rule.whenThisDoesNotApply.length).toBeGreaterThanOrEqual(2);
      for (const caveat of rule.whenThisDoesNotApply) {
        expect(caveat.length).toBeGreaterThan(40);
      }
    }
  });

  it("suggests a step to take rather than a target to hit", () => {
    for (const rule of ruleList()) {
      expect(rule.whatToDo.length).toBeGreaterThan(40);
      expect(promises(rule.whatToDo)).toBe(false);
    }
  });

  it("names where its figures came from", () => {
    for (const rule of ruleList()) {
      expect(rule.basis.length).toBeGreaterThan(20);
    }
  });

  it("sends the ones with consequences to a person", () => {
    // Borrowing and solvency are not decisions a query gets to make.
    expect(RULES.CASH_SHORTFALL_AHEAD.needsProfessional).toBe(true);
    expect(RULES.SHORT_ON_WORKING_CAPITAL.needsProfessional).toBe(true);
    expect(PROFESSIONAL_NOTE).toMatch(/accountant/i);
  });

  it("holds every named suggestion and nothing else", () => {
    expect(ruleList()).toHaveLength(SUGGESTION_KEYS.length);
    for (const key of SUGGESTION_KEYS) {
      expect(RULES[key].key).toBe(key);
    }
    expect(CATALOGUE_VERSION).toMatch(/^advisor_catalogue_v\d+$/);
  });
});

describe("what a suggestion is worth", () => {
  it("states a recorded amount as a fact, because it is one", () => {
    const impact = recorded("48000", "already invoiced and past due");
    expect(impact).toMatchObject({ kind: "recorded", amount: "48000.0000" });
  });

  it("turns an estimate into the band it always was", () => {
    const impact = estimated("10000", "if the margin returned to your average");
    expect(impact.kind).toBe("estimated");
    if (impact.kind !== "estimated") return;
    expect(impact.low).toBe("7000.0000");
    expect(impact.high).toBe("13000.0000");
    expect(ESTIMATE_SPREAD_PERCENT).toBe(30);
  });

  it("carries the assumption with the estimate rather than under it", () => {
    const impact = estimated("5000", "if those items sold at cost");
    if (impact.kind !== "estimated") throw new Error("expected an estimate");
    expect(impact.assumption).toBe("if those items sold at cost");
  });

  it("declines to put a number on what it cannot know", () => {
    const impact = unquantified("what losing this customer would cost");
    expect(impact).toEqual({
      kind: "unquantified",
      why: "what losing this customer would cost",
    });
    expect(rankingAmount(impact)).toBe("0.0000");
  });

  it("ranks an estimate on the low end of its band", () => {
    // Ordering the list by the optimistic end would put the most speculative
    // suggestions at the top, which is exactly backwards.
    expect(rankingAmount(estimated("10000", "assumption"))).toBe("7000.0000");
  });
});

describe("urgency", () => {
  const at = (key: Parameters<typeof urgencyFor>[0]["key"], amount: string) =>
    urgencyFor({
      key,
      impact: recorded(amount, "outstanding"),
      periodRevenue: "1000000",
    });

  it("starts where the catalogue puts it", () => {
    expect(at("OVERDUE_RECEIVABLES", "1000").urgency).toBe("SOON");
    expect(at("SLOW_MOVING_STOCK", "1000").urgency).toBe("WHEN_YOU_CAN");
  });

  it("rises when the amount is large against this shop's own turnover", () => {
    const result = at("OVERDUE_RECEIVABLES", "150000");
    expect(result.urgency).toBe("NOW");
    expect(result.escalated).toBe(true);
    expect(MATERIAL_SHARE_PERCENT).toBe(10);
  });

  it("rises one step, not to the top", () => {
    // A very large slow-moving stock holding is worth attention. It is still
    // not the same kind of problem as running out of cash next Tuesday.
    expect(at("SLOW_MOVING_STOCK", "900000").urgency).toBe("SOON");
  });

  it("does not fall for a small amount", () => {
    // ₹200 somebody owes you is still ₹200 somebody owes you.
    expect(at("OVERDUE_RECEIVABLES", "200").urgency).toBe("SOON");
  });

  it("leaves what is already urgent alone", () => {
    const result = urgencyFor({
      key: "CASH_SHORTFALL_AHEAD",
      impact: recorded("50", "the dip"),
      periodRevenue: "1000000",
    });
    expect(result).toEqual({ urgency: "NOW", escalated: false });
  });

  it("does not escalate against a shop that has not traded", () => {
    // Every amount is infinitely large against nil revenue, which would make
    // everything urgent on a business's first day.
    const result = urgencyFor({
      key: "OVERDUE_RECEIVABLES",
      impact: recorded("5000", "outstanding"),
      periodRevenue: "0",
    });
    expect(result).toEqual({ urgency: "SOON", escalated: false });
  });
});

describe("the order they are read in", () => {
  const suggestion = (
    key: Suggestion["key"],
    urgency: Suggestion["urgency"],
    amount: string,
  ): Suggestion => ({
    key,
    observation: "",
    evidence: {},
    impact: recorded(amount, "x"),
    urgency,
    escalated: false,
  });

  it("puts urgency ahead of size", () => {
    const ordered = rank([
      suggestion("SLOW_MOVING_STOCK", "WHEN_YOU_CAN", "900000"),
      suggestion("CASH_SHORTFALL_AHEAD", "NOW", "1000"),
    ]);
    expect(ordered[0]?.key).toBe("CASH_SHORTFALL_AHEAD");
  });

  it("puts the larger amount first within the same urgency", () => {
    const ordered = rank([
      suggestion("OVERDUE_RECEIVABLES", "SOON", "1000"),
      suggestion("MARGIN_SLIPPING", "SOON", "50000"),
    ]);
    expect(ordered[0]?.key).toBe("MARGIN_SLIPPING");
  });

  it("does not shuffle between runs on equal figures", () => {
    const input = [
      suggestion("MARGIN_SLIPPING", "SOON", "1000"),
      suggestion("OVERDUE_RECEIVABLES", "SOON", "1000"),
    ];
    expect(rank(input).map((entry) => entry.key)).toEqual(
      rank([...input].reverse()).map((entry) => entry.key),
    );
  });

  it("leaves the input alone", () => {
    const input = [
      suggestion("SLOW_MOVING_STOCK", "WHEN_YOU_CAN", "1"),
      suggestion("CASH_SHORTFALL_AHEAD", "NOW", "1"),
    ];
    rank(input);
    expect(input[0]?.key).toBe("SLOW_MOVING_STOCK");
  });
});
