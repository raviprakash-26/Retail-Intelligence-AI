/**
 * Password policy — the single definition, shared by client and server.
 *
 * This module is deliberately isomorphic: it reads no environment variables
 * and imports no server-only dependencies, so the strength meter in the
 * browser and the gate on the server evaluate a password with exactly the same
 * code. A meter that says "Strong" over a password the server then rejects is
 * a bug this factoring makes impossible.
 *
 * Hashing lives in `./password`, which is server-only.
 */

/** NIST SP 800-63B: length dominates; arbitrary composition rules do not. */
export const PASSWORD_MIN_LENGTH = 10;

/** bcrypt silently truncates past 72 bytes, so an explicit ceiling is honest. */
export const PASSWORD_MAX_LENGTH = 128;

/** Passwords that appear in every credential-stuffing list. */
const COMMON_PASSWORDS = new Set([
  "password",
  "password1",
  "password123",
  "passw0rd",
  "12345678",
  "123456789",
  "1234567890",
  "qwertyuiop",
  "iloveyou",
  "admin123",
  "welcome123",
  "letmein123",
  "abc123456",
  "1q2w3e4r5t",
  "qwerty123",
  "retail123",
  "business123",
]);

const SEQUENCES = /^(?:0123456789|1234567890|abcdefghij|qwertyuiop)/;

export type PasswordStrengthLabel =
  "Very weak" | "Weak" | "Fair" | "Good" | "Strong";

export type PasswordStrength = {
  score: 0 | 1 | 2 | 3 | 4;
  label: PasswordStrengthLabel;
  /** Why the password was rejected, in language a user can act on. */
  issues: string[];
  /** The gate. `false` means the server will refuse this password. */
  acceptable: boolean;
};

const LABELS: readonly PasswordStrengthLabel[] = [
  "Very weak",
  "Weak",
  "Fair",
  "Good",
  "Strong",
];

/**
 * Evaluate a password against the policy.
 *
 * `score` drives the strength meter; `acceptable` is what the server enforces.
 * Context (the user's email and name) is used to reject passwords built from
 * information an attacker already has.
 */
export function evaluatePasswordStrength(
  password: string,
  context: { email?: string; name?: string } = {},
): PasswordStrength {
  const issues: string[] = [];
  const normalised = password.toLowerCase();

  if (password.length < PASSWORD_MIN_LENGTH) {
    issues.push(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    issues.push(`Use at most ${PASSWORD_MAX_LENGTH} characters.`);
  }
  if (COMMON_PASSWORDS.has(normalised)) {
    issues.push("This password appears in common breach lists.");
  }
  if (password.length > 0 && /^(.)\1+$/.test(password)) {
    issues.push("Avoid repeating a single character.");
  }
  if (SEQUENCES.test(normalised)) {
    issues.push("Avoid keyboard and alphabet sequences.");
  }

  const emailLocal = context.email?.split("@")[0]?.toLowerCase();
  if (emailLocal && emailLocal.length >= 4 && normalised.includes(emailLocal)) {
    issues.push("Do not include your email address in your password.");
  }

  const firstName = context.name?.trim().split(/\s+/)[0]?.toLowerCase();
  if (firstName && firstName.length >= 4 && normalised.includes(firstName)) {
    issues.push("Do not include your name in your password.");
  }

  let score = 0;
  if (password.length >= PASSWORD_MIN_LENGTH) score += 1;
  if (password.length >= 14) score += 1;

  const characterClasses = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(
    (pattern) => pattern.test(password),
  ).length;
  if (characterClasses >= 2) score += 1;
  if (characterClasses >= 3) score += 1;

  // A password that fails a hard rule never reads as better than "Weak",
  // whatever its length and variety.
  if (issues.length > 0) score = Math.min(score, 1);

  const clamped = Math.max(0, Math.min(4, score)) as 0 | 1 | 2 | 3 | 4;

  return {
    score: clamped,
    label: LABELS[clamped] ?? "Very weak",
    issues,
    // Length and the breach/context checks are the gate. Character-class
    // variety informs the meter but never blocks a long passphrase.
    acceptable:
      issues.length === 0 &&
      password.length >= PASSWORD_MIN_LENGTH &&
      password.length <= PASSWORD_MAX_LENGTH,
  };
}
