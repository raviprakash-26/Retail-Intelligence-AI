import "server-only";
import bcrypt from "bcryptjs";
import { env } from "@/lib/env";
import { PASSWORD_MAX_LENGTH } from "./password-policy";

/**
 * Password hashing.
 *
 * Server-only: it reads the work factor from the environment and pulls in
 * bcrypt, neither of which belongs in a browser bundle. The *policy* — what
 * counts as an acceptable password — lives in `./password-policy`, which is
 * isomorphic and shared with the client.
 *
 * bcrypt is used with a per-password salt and a configurable cost, so the
 * factor can be raised as hardware improves without a code change, and dropped
 * to 4 in tests so the suite stays fast.
 */

export {
  evaluatePasswordStrength,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  type PasswordStrength,
} from "./password-policy";

export async function hashPassword(plaintext: string): Promise<string> {
  if (plaintext.length > PASSWORD_MAX_LENGTH) {
    // Rejecting is safer than letting bcrypt silently truncate at 72 bytes and
    // leaving the user believing their 200-character password was honoured.
    throw new RangeError(
      `Password exceeds the maximum length of ${PASSWORD_MAX_LENGTH} characters`,
    );
  }
  return bcrypt.hash(plaintext, env.PASSWORD_HASH_ROUNDS);
}

export async function verifyPassword(
  plaintext: string,
  hash: string,
): Promise<boolean> {
  try {
    return await bcrypt.compare(plaintext, hash);
  } catch {
    return false;
  }
}

/** A real bcrypt digest of a value nobody knows, used only for timing parity. */
const DUMMY_HASH =
  "$2b$12$C6UzMDM.H6dfI/f/IKcEe.9L1G8mF3Kx3n8xN0h5xN1oQ2xJ8mS4W";

/**
 * Burns roughly the time a real verification would take.
 *
 * When a sign-in is attempted for an address that does not exist, the handler
 * still runs a comparison so response timing does not reveal which emails are
 * registered.
 */
export async function fakeVerifyPassword(plaintext: string): Promise<false> {
  await bcrypt.compare(plaintext, DUMMY_HASH).catch(() => false);
  return false;
}
