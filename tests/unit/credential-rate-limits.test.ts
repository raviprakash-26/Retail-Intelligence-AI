import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RATE_LIMITS } from "@/server/security/rate-limit";

/**
 * An endpoint that takes a guess at a credential is limited on both axes.
 *
 * `rate-limit.ts` explains why one is not enough: IP-only limiting lets a
 * botnet spread an attack on a single account across thousands of addresses,
 * and account-only limiting lets one address spray a whole user list.
 *
 * It used to claim that "two independent keys guard every credential
 * endpoint". Three endpoints had fewer than two for reasons nobody had written
 * down, and a fourth had fewer than two for no reason at all —
 * `acceptInvitationAction` issued a session on the strength of a password while
 * budgeting only the caller's IP address. That is a password oracle with an IP
 * limit, and **this sweep would have caught it**. It is the reason the sweep
 * exists rather than a comment saying the sentence is now accurate.
 *
 * The distinction the exemptions turn on is not whether an endpoint touches a
 * password. It is whether an attacker gets to guess: a reset link carries 32
 * random bytes, and 256 bits is not guessable at any rate.
 */

/** Which of the two axes each bucket counts on. */
const AXIS: Partial<Record<keyof typeof RATE_LIMITS, "ip" | "account">> = {
  SIGN_IN_IP: "ip",
  SIGN_IN_ACCOUNT: "account",
  REGISTER_IP: "ip",
  PASSWORD_RESET_IP: "ip",
  PASSWORD_RESET_ACCOUNT: "account",
  // Keyed by the signed-in user, which is the account axis by another name.
  RESEND_VERIFICATION: "account",
};

/**
 * Endpoints that handle a credential and do not carry both keys, with the
 * reason. Named rather than inferred, for the reason the authorization sweep
 * gives: an omission and a decision look identical in a codebase.
 */
const DELIBERATE: Record<string, string> = {
  registerAction:
    "There is no account to key on yet. The IP axis is the only one that exists, and the address is what it is protecting against.",
  resetPasswordAction:
    "The link carries 32 random bytes, so there is nothing to guess. A counter would only spend a budget on the mail scanner that prefetched the link. The token is validated before the password is hashed, so an invalid one costs an indexed lookup rather than an argon2 hash.",
  verifyEmailAction:
    "As `resetPasswordAction`, and more exposed to prefetching: a verification link is the one most likely to be fetched by something that is not the recipient.",
  resendVerificationAction:
    "Needs a session, so the actor is already identified and the account axis is the one that means anything.",
};

/** What makes an action one this rule is about. */
const HANDLES_A_CREDENTIAL = [
  "verifyPassword(",
  "hashPassword(",
  "issueToken(",
  "hashToken(",
  "createSession(",
];

const SOURCES = ["src/server/auth/actions.ts", "src/server/company/actions.ts"];

type Endpoint = { name: string; handles: string[]; buckets: string[] };

function endpoints(): Endpoint[] {
  const found: Endpoint[] = [];
  for (const file of SOURCES) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/^export async function (\w+)\(/gm)) {
      // Bounded at the closing brace in the first column, which is where
      // Prettier ends a top-level function and nowhere else.
      const rest = source.slice(match.index);
      const end = rest.search(/^\}$/m);
      const body = end === -1 ? rest : rest.slice(0, end + 1);

      const handles = HANDLES_A_CREDENTIAL.filter((mark) =>
        body.includes(mark),
      );
      if (handles.length === 0) continue;

      found.push({
        name: match[1]!,
        handles,
        buckets: [...body.matchAll(/checkRateLimit\(\s*"([A-Z_]+)"/g)].map(
          (hit) => hit[1]!,
        ),
      });
    }
  }
  return found;
}

function axesOf(endpoint: Endpoint): Set<"ip" | "account"> {
  const axes = new Set<"ip" | "account">();
  for (const bucket of endpoint.buckets) {
    const axis = AXIS[bucket as keyof typeof RATE_LIMITS];
    if (axis) axes.add(axis);
  }
  return axes;
}

describe("endpoints that handle a credential", () => {
  const found = endpoints();

  it("are found at all", () => {
    // A scan that stopped matching would make every check below vacuously
    // true. Sign-in is the one that must always be in the list.
    expect(found.length).toBeGreaterThanOrEqual(6);
    expect(found.map((entry) => entry.name)).toContain("signInAction");
  });

  it("are limited on both axes, or named with a reason", () => {
    const thin = found
      .filter((entry) => !(entry.name in DELIBERATE))
      .filter((entry) => axesOf(entry).size < 2)
      .map(
        (entry) =>
          `${entry.name} (${entry.handles.map((mark) => mark.replace("(", "")).join(", ")}) has ${
            entry.buckets.length > 0 ? entry.buckets.join(" + ") : "no limit"
          }`,
      );

    expect(thin).toEqual([]);
  });

  it("keeps the exemption list honest", () => {
    // An exemption for an endpoint that has since been given both keys, or has
    // stopped handling a credential, is a claim nobody has checked in a while.
    const stale = Object.keys(DELIBERATE).filter((name) => {
      const entry = found.find((candidate) => candidate.name === name);
      return !entry || axesOf(entry).size >= 2;
    });

    expect(stale).toEqual([]);
  });

  it("classifies every bucket the endpoints actually use", () => {
    // The axis map is what the rule is measured against, so a bucket used by a
    // credential endpoint and missing from it would silently read as neither
    // axis — and an endpoint carrying two unclassified buckets would fail for
    // a reason nobody could act on.
    const unclassified = found
      .flatMap((entry) => entry.buckets)
      .filter((bucket) => !(bucket in AXIS));

    expect([...new Set(unclassified)]).toEqual([]);
  });
});
