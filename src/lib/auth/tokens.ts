import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Opaque token generation and hashing for sessions, email verification and
 * password resets.
 *
 * Only the SHA-256 digest of a token is ever stored. A database dump therefore
 * yields nothing an attacker can present as a valid session or reset link.
 * SHA-256 (rather than bcrypt) is correct here: these tokens carry 256 bits of
 * entropy, so there is no dictionary to slow down, and lookups must be fast.
 */

/** 32 bytes ⇒ 256 bits of entropy, encoded base64url (43 characters). */
const TOKEN_BYTES = 32;

export type IssuedToken = {
  /** Sent to the user. Never persisted. */
  token: string;
  /** Persisted. Never sent. */
  tokenHash: string;
};

export function issueToken(): IssuedToken {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Compare two hex digests without leaking their difference through timing.
 */
export function tokensMatch(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

export const TOKEN_TTL = {
  /** Long enough to survive a slow inbox, short enough to limit exposure. */
  EMAIL_VERIFICATION_MS: 24 * 60 * 60 * 1000,
  /** Deliberately short: a reset link is a live credential. */
  PASSWORD_RESET_MS: 60 * 60 * 1000,
  MEMBER_INVITATION_MS: 7 * 24 * 60 * 60 * 1000,
  EMAIL_CHANGE_MS: 60 * 60 * 1000,
} as const;

export function expiresAt(ttlMs: number, from: Date = new Date()): Date {
  return new Date(from.getTime() + ttlMs);
}

export function isExpired(expiry: Date, now: Date = new Date()): boolean {
  return expiry.getTime() <= now.getTime();
}
