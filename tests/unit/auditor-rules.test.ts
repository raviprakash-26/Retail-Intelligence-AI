import { describe, expect, it } from "vitest";
import {
  accuses,
  FORBIDDEN_WORDS,
  RULE_KEYS,
  RULES,
  RULES_VERSION,
  ruleList,
  riskLevelFrom,
  SCORE_DISCLAIMER,
  scoreFrom,
  SEVERITY_ORDER,
  type Severity,
} from "@/lib/auditor/rules";

/**
 * What the auditor is allowed to say.
 *
 * The arithmetic of the score is the easy part. The part worth protecting is
 * the vocabulary: a set of database queries has no standing to call anybody
 * dishonest, and a small business owner reading "possible fraud" about their
 * own shop is being told something the software does not know.
 */

describe("the auditor cannot accuse anybody", () => {
  it("uses none of the words it has no standing to use", () => {
    for (const rule of ruleList()) {
      const text = [
        rule.title,
        rule.description,
        rule.recommendation,
        ...rule.ordinaryExplanations,
      ].join(" ");

      for (const word of FORBIDDEN_WORDS) {
        expect(text.toLowerCase(), `${rule.key} uses "${word}"`).not.toContain(
          word,
        );
      }
    }
  });

  it("recognises an accusation when it sees one", () => {
    expect(accuses("This looks like possible fraud.")).toBe(true);
    expect(accuses("Stock may have been STOLEN")).toBe(true);
    expect(accuses("Cash in hand went below zero.")).toBe(false);
  });

  it("gives every rule the ordinary explanations for what it found", () => {
    // Almost every one of these has an innocent cause more likely than a
    // dishonest one, and the finding has to carry it.
    for (const rule of ruleList()) {
      expect(rule.ordinaryExplanations.length).toBeGreaterThan(0);
      for (const explanation of rule.ordinaryExplanations) {
        expect(explanation.length).toBeGreaterThan(30);
      }
    }
  });

  it("recommends a check to make rather than a person to suspect", () => {
    for (const rule of ruleList()) {
      expect(rule.recommendation.length).toBeGreaterThan(30);
      expect(accuses(rule.recommendation)).toBe(false);
    }
  });

  it("describes what the books show, not what it means", () => {
    // A finding is a fact about records. Whether it means anything about the
    // people involved is not something a query can establish.
    for (const rule of ruleList()) {
      expect(rule.description.length).toBeGreaterThan(40);
      expect(rule.title).not.toMatch(/suspicious|suspect/i);
    }
  });
});

describe("the catalogue", () => {
  it("holds every named rule and nothing else", () => {
    expect(ruleList()).toHaveLength(RULE_KEYS.length);
    for (const key of RULE_KEYS) {
      expect(RULES[key].key).toBe(key);
    }
  });

  it("puts the ledger not balancing above everything else", () => {
    // Every report is unreliable until that one is explained.
    expect(RULES.LEDGER_OUT_OF_BALANCE.severity).toBe("CRITICAL");
    const others = ruleList().filter(
      (rule) => rule.key !== "LEDGER_OUT_OF_BALANCE",
    );
    for (const rule of others) {
      expect(SEVERITY_ORDER[rule.severity]).toBeLessThan(
        SEVERITY_ORDER["CRITICAL"],
      );
    }
  });

  it("keeps a version so a run can say which rules produced it", () => {
    expect(RULES_VERSION).toMatch(/^auditor_rules_v\d+$/);
  });
});

describe("the score", () => {
  const at = (...severities: Severity[]) =>
    scoreFrom(severities.map((severity) => ({ severity })));

  it("is a hundred when nothing was found", () => {
    expect(at()).toBe(100);
  });

  it("takes more off for worse findings", () => {
    expect(at("LOW")).toBeGreaterThan(at("MEDIUM"));
    expect(at("MEDIUM")).toBeGreaterThan(at("HIGH"));
    expect(at("HIGH")).toBeGreaterThan(at("CRITICAL"));
  });

  it("can be re-derived by hand", () => {
    // The whole argument for showing a composite: a reader can check it.
    expect(at("HIGH", "MEDIUM", "LOW")).toBe(100 - 15 - 6 - 2);
  });

  it("never goes below nil however much is found", () => {
    expect(at("CRITICAL", "CRITICAL", "CRITICAL", "CRITICAL")).toBe(0);
  });

  it("ignores findings that are only for information", () => {
    expect(at("INFO", "INFO")).toBe(100);
  });

  it("carries a disclaimer saying what it is not", () => {
    expect(SCORE_DISCLAIMER).toMatch(/not a measure of honesty/i);
    expect(SCORE_DISCLAIMER).toMatch(/not comparable/i);
  });
});

describe("the risk level", () => {
  const of = (...severities: Severity[]) =>
    riskLevelFrom(severities.map((severity) => ({ severity })));

  it("is the worst thing found", () => {
    expect(of("LOW", "HIGH", "MEDIUM")).toBe("HIGH");
    expect(of("MEDIUM", "CRITICAL")).toBe("CRITICAL");
  });

  it("is only informational when nothing was found", () => {
    expect(of()).toBe("INFO");
    expect(of("INFO")).toBe("INFO");
  });

  it("does not rise with the number of small findings", () => {
    // Twenty small things are still twenty small things. The score moves; the
    // level does not, because inflating it would make "HIGH" meaningless.
    expect(of(...Array<Severity>(20).fill("LOW"))).toBe("LOW");
  });
});
