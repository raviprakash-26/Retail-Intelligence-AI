import { describe, expect, it } from "vitest";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  evaluatePasswordStrength,
} from "@/lib/auth/password-policy";

/**
 * The policy module is isomorphic on purpose: the browser's strength meter and
 * the server's gate call this same function, so a password can never be shown
 * as acceptable and then rejected on submit. These tests pin the behaviour
 * both sides depend on.
 */

const CASES: ReadonlyArray<{
  label: string;
  password: string;
  context?: { email?: string; name?: string };
  acceptable: boolean;
}> = [
  { label: "empty", password: "", acceptable: false },
  { label: "too short", password: "Short1!", acceptable: false },
  {
    label: "exactly at the minimum length",
    password: "shopledger",
    acceptable: true,
  },
  // Ten characters, but every one of them straight off the alphabet.
  {
    label: "minimum length but an alphabet run",
    password: "abcdefghij",
    acceptable: false,
  },
  {
    label: "a strong passphrase",
    password: "correct horse battery staple",
    acceptable: true,
  },
  {
    label: "mixed character classes",
    password: "Retail!ntel2026",
    acceptable: true,
  },
  {
    label: "a common breach-list entry",
    password: "password123",
    acceptable: false,
  },
  {
    label: "a single repeated character",
    password: "aaaaaaaaaaaa",
    acceptable: false,
  },
  {
    label: "a keyboard sequence",
    password: "qwertyuiop123",
    acceptable: false,
  },
  {
    label: "containing the email local part",
    password: "raviprakash2026",
    context: { email: "raviprakash@example.com" },
    acceptable: false,
  },
  {
    label: "containing the user's first name",
    password: "prakashRetail1",
    context: { name: "Prakash Kumar" },
    acceptable: false,
  },
  {
    label: "a short first name that must not trigger the check",
    password: "MountainRiver42",
    context: { name: "Ram Singh" },
    acceptable: true,
  },
  {
    label: "over the maximum length",
    password: "a1B!".repeat(40),
    acceptable: false,
  },
];

describe("password policy — accept / reject", () => {
  for (const testCase of CASES) {
    it(testCase.label, () => {
      const result = evaluatePasswordStrength(
        testCase.password,
        testCase.context,
      );
      expect(result.acceptable).toBe(testCase.acceptable);

      // A rejection must always come with a reason a user can act on.
      if (!testCase.acceptable) {
        expect(result.issues.length).toBeGreaterThan(0);
      } else {
        expect(result.issues).toHaveLength(0);
      }
    });
  }
});

describe("password policy — scoring", () => {
  it("never scores a rejected password above 1", () => {
    for (const testCase of CASES.filter((item) => !item.acceptable)) {
      const result = evaluatePasswordStrength(
        testCase.password,
        testCase.context,
      );
      expect(result.score, testCase.label).toBeLessThanOrEqual(1);
    }
  });

  it("scores a long, varied password at the top of the range", () => {
    const result = evaluatePasswordStrength("Tr0ub4dor&3xample");
    expect(result.score).toBe(4);
    expect(result.label).toBe("Strong");
  });

  it("rewards length over character-class gymnastics", () => {
    const passphrase = evaluatePasswordStrength("chair window mango lantern");
    const short = evaluatePasswordStrength("Ab1!efghij");
    expect(passphrase.score).toBeGreaterThanOrEqual(short.score);
    expect(passphrase.acceptable).toBe(true);
  });

  it("always returns a label matching its score", () => {
    const labels = ["Very weak", "Weak", "Fair", "Good", "Strong"];
    for (const testCase of CASES) {
      const result = evaluatePasswordStrength(
        testCase.password,
        testCase.context,
      );
      expect(result.label).toBe(labels[result.score]);
    }
  });

  it("explains a length rejection specifically", () => {
    const result = evaluatePasswordStrength("abc");
    expect(result.issues[0]).toContain(String(PASSWORD_MIN_LENGTH));
  });
});

describe("password policy — boundaries", () => {
  it("accepts a password exactly at the maximum length", () => {
    const password = `Zx9!${"q".repeat(PASSWORD_MAX_LENGTH - 4)}`;
    expect(password).toHaveLength(PASSWORD_MAX_LENGTH);
    expect(evaluatePasswordStrength(password).acceptable).toBe(true);
  });

  it("rejects a password one character over the maximum", () => {
    const password = `Zx9!${"q".repeat(PASSWORD_MAX_LENGTH - 3)}`;
    expect(password).toHaveLength(PASSWORD_MAX_LENGTH + 1);
    expect(evaluatePasswordStrength(password).acceptable).toBe(false);
  });

  it("rejects one character below the minimum", () => {
    const password = "a".repeat(PASSWORD_MIN_LENGTH - 1);
    expect(evaluatePasswordStrength(password).acceptable).toBe(false);
  });

  it("matches breach-list entries case-insensitively", () => {
    expect(evaluatePasswordStrength("PASSWORD123").acceptable).toBe(false);
    expect(evaluatePasswordStrength("Password123").acceptable).toBe(false);
  });

  it("ignores context it was not given", () => {
    expect(evaluatePasswordStrength("MountainRiver42").acceptable).toBe(true);
  });
});
