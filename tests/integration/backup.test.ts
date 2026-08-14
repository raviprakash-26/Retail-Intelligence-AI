import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RegisterInput } from "@/lib/validation/auth";
import { registerOwner } from "@/server/auth/registration";
import {
  disconnectTestDb,
  ensurePlatformData,
  purgeTestCompany,
  purgeTestUsers,
  testDb,
  uniqueSlug,
} from "../helpers/test-db";

/**
 * The backup, and the restore nobody rehearsed.
 *
 * A `pg_dump` that exits 0 is not a backup. It is a file, and the only thing
 * that makes it a backup is somebody having restored it and found the ledger
 * intact. That is the most common way people discover theirs was broken — at
 * the moment they needed it, which is the one moment it cannot be fixed.
 *
 * So this test does the whole round trip against a real database: back the test
 * database up, restore it into a scratch one, and count what arrived. It is
 * slower than testing the script's arguments and it is the only version worth
 * having.
 *
 * It skips rather than fails where the Postgres client tools are absent, and
 * says so, because "no pg_dump on this machine" is a fact about the machine and
 * not a defect in the product.
 */

/**
 * Whether this machine can run the round trip at all.
 *
 * Not just "is pg_dump installed" but "is it new enough". A client older than
 * the server refuses to dump — `server version 16.x; pg_dump version 14.x` —
 * and that is a fact about the machine rather than a defect in the scripts, so
 * it skips with a reason instead of failing. CI installs a matching client so
 * the round trip is genuinely exercised there.
 */
const CLIENT_TOOLS: { usable: boolean; why: string } = (() => {
  try {
    const version = execFileSync("pg_dump", ["--version"], {
      encoding: "utf8",
    });
    execFileSync("pg_restore", ["--version"], { stdio: "ignore" });
    const major = Number(/(\d+)/.exec(version)?.[1] ?? 0);
    if (major < 16) {
      return {
        usable: false,
        why: `pg_dump ${major} is older than the server`,
      };
    }
    return { usable: true, why: "" };
  } catch {
    return { usable: false, why: "pg_dump or pg_restore is not installed" };
  }
})();

const HAS_CLIENT_TOOLS = CLIENT_TOOLS.usable;

if (!HAS_CLIENT_TOOLS) {
  console.warn(`backup round trip skipped: ${CLIENT_TOOLS.why}`);
}

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const SCRATCH = DATABASE_URL.replace(/\/([^/?]+)(\?|$)/, "/riai_scratch$2");

/**
 * The same URL with Prisma's `?schema=` removed.
 *
 * libpq rejects that parameter outright, and every URL in this project carries
 * it — which is what the scripts themselves have to strip, and what `psql`
 * needs here for the same reason.
 */
const libpq = (url: string) =>
  url.replace(/([?&])schema=[^&]*&?/, "$1").replace(/[?&]$/, "");

const prisma = testDb();
const createdCompanies: string[] = [];
const createdEmails: string[] = [];
let workspace = "";
let scratchClient: PrismaClient | undefined;

function registrationInput(email: string): RegisterInput {
  return {
    account: {
      fullName: "Ravi Prakash",
      email,
      mobile: "9845012345",
      password: "MountainRiver42!",
      confirmPassword: "MountainRiver42!",
      acceptTerms: true,
    },
    business: {
      businessName: `Backup ${uniqueSlug("Mart")}`,
      businessType: "SOLE_PROPRIETORSHIP",
      gstRegistration: "REGULAR",
      gstin: "29AAAPR1234K1ZP",
      pan: "AAAPR1234K",
      addressLine1: "42 Avenue Road",
      city: "Bengaluru",
      stateCode: "29",
      pincode: "560053",
    },
    accounting: {
      fiscalYearStartMonth: 4,
      currency: "INR",
      openingCashBalance: 250_000,
      openingBankBalance: 0,
      inventoryMethod: "WEIGHTED_AVERAGE",
      loadDemoData: false,
    },
  };
}

/** Runs a repository script with the environment it expects. */
function runScript(
  script: string,
  args: readonly string[] = [],
  env: Record<string, string> = {},
): string {
  return execFileSync(join(process.cwd(), "scripts", script), [...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

beforeAll(async () => {
  if (!HAS_CLIENT_TOOLS) return;
  await ensurePlatformData();
  workspace = mkdtempSync(join(tmpdir(), "riai-backup-"));

  // A company with real posted history, so the restore has something to lose.
  const email = `bkp-${uniqueSlug("x").replace(/-/g, "")}@example.com`;
  createdEmails.push(email);
  const result = await registerOwner(registrationInput(email));
  createdCompanies.push(result.companyId);
}, 120_000);

afterAll(async () => {
  await scratchClient?.$disconnect();
  for (const companyId of createdCompanies) {
    await purgeTestCompany(companyId).catch(() => undefined);
  }
  await purgeTestUsers(createdEmails);
  await disconnectTestDb();
  if (workspace && existsSync(workspace)) {
    rmSync(workspace, { recursive: true, force: true });
  }
}, 120_000);

describe.skipIf(!HAS_CLIENT_TOOLS)("backing the ledger up", () => {
  it("writes a dump that contains table data, and says what it wrote", () => {
    const output = runScript("backup.sh", [], {
      DATABASE_URL,
      BACKUP_DIR: workspace,
    });

    expect(output).toMatch(/wrote .*\.dump/);
    // The script counts the tables it can read back, rather than trusting the
    // exit code of pg_dump.
    expect(output).toMatch(/\d+ tables/);

    const dumps = readdirSync(workspace).filter((name) =>
      name.endsWith(".dump"),
    );
    expect(dumps).toHaveLength(1);
  }, 120_000);

  it("restores into a scratch database with the ledger intact", async () => {
    const dumps = readdirSync(workspace).filter((name) =>
      name.endsWith(".dump"),
    );
    const dump = join(workspace, dumps[0]!);

    // A database whose name ends in _scratch, which the guard permits.
    for (const statement of [
      "DROP DATABASE IF EXISTS riai_scratch",
      "CREATE DATABASE riai_scratch",
    ]) {
      execFileSync("psql", [
        libpq(DATABASE_URL),
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        statement,
      ]);
    }

    runScript("restore.sh", [dump, SCRATCH]);

    // The assertion that matters: this company's books came back whole.
    //
    // Deliberately not a comparison of global row counts. The dump is a
    // snapshot and the suite's other files keep writing to the same database,
    // so "the restored total equals the live total" is a race that fails on a
    // busy run and passes on a quiet one. A company created before the dump is
    // in it, and stays in it however much else moves.
    scratchClient = new PrismaClient({ datasourceUrl: SCRATCH });
    const companyId = createdCompanies[0]!;

    const [company, accounts, lines] = await Promise.all([
      scratchClient.company.findUnique({
        where: { id: companyId },
        select: { name: true },
      }),
      scratchClient.account.count({ where: { companyId } }),
      scratchClient.journalLine.count({ where: { companyId } }),
    ]);
    const [sourceAccounts, sourceLines] = await Promise.all([
      prisma.account.count({ where: { companyId } }),
      prisma.journalLine.count({ where: { companyId } }),
    ]);

    expect(company?.name).toMatch(/^Backup /);
    expect(accounts).toBe(sourceAccounts);
    expect(lines).toBe(sourceLines);
    // Opening balances alone put entries in the ledger, so a restore that
    // brought back an empty books would be caught here.
    expect(lines).toBeGreaterThan(0);
  }, 180_000);

  it("refuses to restore over a database that is not obviously a target", () => {
    const dumps = readdirSync(workspace).filter((name) =>
      name.endsWith(".dump"),
    );
    const dump = join(workspace, dumps[0]!);

    // `pg_restore --clean` drops and recreates everything it touches, and the
    // wrong URL is one shell-history entry away from the right one.
    let refused = false;
    let message = "";
    try {
      execFileSync(join(process.cwd(), "scripts", "restore.sh"), [
        dump,
        "postgresql://riai:riai@localhost:5432/riai_production",
      ]);
    } catch (error) {
      refused = true;
      message = String((error as { stderr?: Buffer }).stderr ?? "");
    }

    expect(refused).toBe(true);
    expect(message).toMatch(/not obviously a restore target/i);
    expect(message).toMatch(/RESTORE_I_MEAN_IT/);
  }, 60_000);

  it("refuses to keep a dump it cannot read back", () => {
    // Pointed at a database that does not exist: pg_dump fails, and the script
    // must not leave a file behind that looks like a backup.
    const empty = mkdtempSync(join(tmpdir(), "riai-empty-"));
    let failed = false;
    try {
      runScript("backup.sh", [], {
        DATABASE_URL: DATABASE_URL.replace(
          /\/([^/?]+)(\?|$)/,
          "/riai_absent$2",
        ),
        BACKUP_DIR: empty,
      });
    } catch {
      failed = true;
    }

    expect(failed).toBe(true);
    expect(readdirSync(empty).filter((name) => name.endsWith(".dump"))).toEqual(
      [],
    );
    rmSync(empty, { recursive: true, force: true });
  }, 60_000);
});
