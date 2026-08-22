import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertEnv, resetEnvCacheForTests } from "@/lib/env";

/**
 * The single-machine deployment can actually be configured.
 *
 * `docker-compose.yml` is the install this repository documents: copy
 * `.env.example`, fill a few things in, `docker compose up`. What is easy to
 * miss is that a container receives only the variables the file names. `.env`
 * is read to fill in the `${...}` placeholders and is otherwise not passed to
 * it at all — so a variable that exists in `.env.example`, is read by
 * `env.ts`, and is not named in the compose file is one the operator can set
 * and the application will never see.
 *
 * That had happened to thirty-one of the thirty-eight settings. Payment keys
 * filled in and payments disabled. A drain window tuned and ignored. And when
 * a boot-time guard arrived for the email driver, a container that refused to
 * start with no way to answer it — the documented install stopped working and
 * nothing here noticed, because nothing here was looking.
 *
 * Two properties, then. That the environment this file hands a container is
 * one the validator accepts, and that every setting the application reads is
 * one whoever deploys it can reach.
 */

const COMPOSE = "docker-compose.yml";

/**
 * The `environment:` block of a service, with `${...}` expanded.
 *
 * A deliberately small reader rather than a YAML dependency: it needs one
 * block of one service from one file whose shape this repository controls.
 * It fails loudly rather than returning something plausible if that shape
 * changes, because a parser that quietly finds nothing would turn both cases
 * below green.
 */
function composeEnvironment(
  service: string,
  dotenv: Record<string, string>,
): Record<string, string> {
  const text = readFileSync(COMPOSE, "utf8");
  const lines = text.split("\n");

  const serviceAt = lines.findIndex((line) => line === `  ${service}:`);
  expect(serviceAt, `no ${service} service in ${COMPOSE}`).toBeGreaterThan(-1);

  let envAt = -1;
  for (let i = serviceAt + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/.test(lines[i] ?? "")) break; // the next service
    if (lines[i] === "    environment:") {
      envAt = i;
      break;
    }
  }
  expect(envAt, `${service} declares no environment`).toBeGreaterThan(-1);

  const found: Record<string, string> = {};
  for (let i = envAt + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    // Anything at four spaces or less has left the block.
    if (!/^ {6}\S/.test(line)) break;
    const match = /^ {6}([A-Z][A-Z0-9_]*): *(.*)$/.exec(line);
    if (!match) continue;
    const name = match[1] ?? "";
    const rawValue = match[2] ?? "";
    found[name] = expand(rawValue.replace(/^"(.*)"$/, "$1"), dotenv);
  }

  expect(
    Object.keys(found).length,
    `read no variables out of ${service} — the file's shape has changed and this reader has not`,
  ).toBeGreaterThan(5);
  return found;
}

/** Resolves `${NAME}`, `${NAME:-default}` and `${NAME:?message}`. */
function expand(value: string, dotenv: Record<string, string>): string {
  return value.replace(
    /\$\{([A-Z][A-Z0-9_]*)(?::([-?])([^}]*))?\}/g,
    (_whole, name: string, kind: string | undefined, rest: string) => {
      const set = dotenv[name];
      if (set !== undefined && set !== "") return set;
      if (kind === "-") return rest;
      // `:?` means the operator must supply it; compose refuses to start
      // without one, so a test that substituted a value would be testing a
      // deployment nobody can have.
      if (kind === "?") return "";
      return "";
    },
  );
}

/**
 * What `.env` holds after the file's own instructions are followed.
 *
 * The header of `docker-compose.yml` names these. If that list and this one
 * ever disagree, the first case below is the one that says so.
 */
const FILLED_IN: Record<string, string> = {
  APP_URL: "https://books.example.com",
  AUTH_SECRET: "PJ9nQxLmT4vRw8ZcHs2JdEaFgU6vNiObTrXyMlPqKw3B",
  POSTGRES_PASSWORD: "a-database-password",
  EMAIL_ALLOW_CONSOLE: "true",
};

let original: NodeJS.ProcessEnv;

beforeEach(() => {
  original = process.env;
  resetEnvCacheForTests();
});

afterEach(() => {
  process.env = original;
  resetEnvCacheForTests();
});

describe("a container built from docker-compose.yml", () => {
  it("starts, once the file's own instructions have been followed", () => {
    // The container gets the compose environment and nothing else — no `.env`
    // on disk, because the image does not carry one.
    process.env = composeEnvironment(
      "app",
      FILLED_IN,
    ) as unknown as NodeJS.ProcessEnv;
    resetEnvCacheForTests();

    expect(() => assertEnv()).not.toThrow();
  });

  it("refuses when the email question has not been answered", () => {
    // Not incidental — this is the case that broke, and it should keep
    // failing for the stated reason rather than passing because the variable
    // stopped being forwarded again.
    const { EMAIL_ALLOW_CONSOLE: _answered, ...unanswered } = FILLED_IN;
    process.env = composeEnvironment(
      "app",
      unanswered,
    ) as unknown as NodeJS.ProcessEnv;
    resetEnvCacheForTests();

    expect(() => assertEnv()).toThrow(/password reset/);
  });
});

describe("every setting the application reads", () => {
  /**
   * Settings the compose file deliberately does not forward, and why.
   *
   * A list with reasons rather than a count: the point of the case below is
   * that adding a setting to `env.ts` and forgetting this file is caught, and
   * a bare number would be satisfied by deleting a line and adding one.
   */
  const NOT_FORWARDED: Record<string, string> = {
    NODE_ENV: "owned by the file — a production container is production",
    DATABASE_URL: "owned by the file — the database is on the compose network",
    SEED_DEMO_DATA:
      "owned by the file — never seed demo data into a real install",
    DIRECT_DATABASE_URL:
      "for deployments behind a connection pooler; there is none in this topology",
    STORAGE_DRIVER:
      "storage configures nothing — no upload path is written yet",
    STORAGE_LOCAL_DIR: "as STORAGE_DRIVER",
    STORAGE_BUCKET: "as STORAGE_DRIVER",
    STORAGE_REGION: "as STORAGE_DRIVER",
    STORAGE_ENDPOINT: "as STORAGE_DRIVER",
    STORAGE_ACCESS_KEY_ID: "as STORAGE_DRIVER",
    STORAGE_SECRET_ACCESS_KEY: "as STORAGE_DRIVER",
    STORAGE_PUBLIC_BASE_URL: "as STORAGE_DRIVER",
  };

  /** Every variable the server schema declares, read from the schema itself. */
  function declaredSettings(): string[] {
    const source = readFileSync("src/lib/env.ts", "utf8");
    const start = source.indexOf("const serverSchema");
    const end = source.indexOf("// Each pluggable driver states");
    expect(
      start >= 0 && end > start,
      "could not find the server schema — this test is reading the wrong thing",
    ).toBe(true);

    const names = [
      ...source.slice(start, end).matchAll(/^ {4}([A-Z][A-Z0-9_]*):/gm),
    ].map((match) => match[1] ?? "");
    expect(names.length).toBeGreaterThan(20);
    return names;
  }

  it("can be set by whoever deploys it", () => {
    const forwarded = new Set(
      Object.keys(composeEnvironment("app", FILLED_IN)),
    );

    const unreachable = declaredSettings().filter(
      (name) => !forwarded.has(name) && !(name in NOT_FORWARDED),
    );

    expect(
      unreachable,
      `these are read by the application and cannot be set in a compose deployment: ${unreachable.join(", ")}`,
    ).toEqual([]);
  });

  it("does not carry an excuse for a setting that no longer exists", () => {
    // The other direction. An allowlist nobody prunes stops describing the
    // code and starts hiding it.
    const declared = new Set(declaredSettings());
    const stale = Object.keys(NOT_FORWARDED).filter(
      (name) => !declared.has(name),
    );

    expect(stale, `no longer in the schema: ${stale.join(", ")}`).toEqual([]);
  });
});
