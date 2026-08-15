import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

/**
 * A stand-in for the AWS CLI, on PATH.
 *
 * The upload itself is the CLI's job and testing it would be testing Amazon's
 * code. What is worth testing is the contract around it: that only a verified
 * dump is sent, that a failed upload fails the run loudly instead of leaving a
 * cron job reporting success, that the object is checked after it lands, and
 * that nothing is pruned when any of that goes wrong.
 *
 * The stub records every invocation to a file so those can be asserted, and
 * `behaviour` chooses how it answers.
 */
function stubAwsCli(
  dir: string,
  behaviour: {
    /** Bytes head-object should report. Defaults to the real file's size. */
    reportedSize?: string;
    /** Make `s3 cp` fail, as an unreachable bucket would. */
    failUpload?: boolean;
    /** Keys list-objects-v2 should return. */
    listKeys?: readonly string[];
  } = {},
): { binDir: string; calls: () => string[][] } {
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const log = join(dir, "aws-calls.log");
  writeFileSync(log, "");

  const size = behaviour.reportedSize;
  // Written to a file the stub cats, rather than embedded in the script.
  // Escaping newlines or tabs through a generated bash literal means `printf`
  // emitting the two characters "\t" instead of a tab, and the script under
  // test then sees one long key rather than several.
  const listingPath = join(dir, "aws-listing.txt");
  writeFileSync(listingPath, (behaviour.listKeys ?? []).join("\n") || "None");

  const script = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
args="$*"
case "$args" in
  *"s3api head-object"*)
    ${
      size === undefined
        ? // Report the real size of whatever was uploaded, which is what a
          // healthy store does.
          `file=$(grep -o '/[^ ]*\\.dump' ${JSON.stringify(log)} | head -n 1); wc -c < "$file" | tr -d ' '`
        : `printf '%s\\n' ${JSON.stringify(size)}`
    }
    ;;
  *"s3api list-objects-v2"*)
    cat ${JSON.stringify(listingPath)}
    ;;
  *"s3 cp"*)
    ${behaviour.failUpload ? 'echo "upload failed" >&2; exit 1' : "exit 0"}
    ;;
  *)
    exit 0
    ;;
esac
`;
  const path = join(binDir, "aws");
  writeFileSync(path, script);
  chmodSync(path, 0o755);

  return {
    binDir,
    calls: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(" ")),
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

describe.skipIf(!HAS_CLIENT_TOOLS)("sending a copy off the machine", () => {
  /** A fresh directory per case, so one run's dumps do not confuse the next. */
  const freshDir = () => mkdtempSync(join(tmpdir(), "riai-offsite-"));

  it("says plainly when there is no off-machine copy", () => {
    // The default, and the state most installations are in. It has to be
    // stated rather than left for somebody to assume.
    const dir = freshDir();
    try {
      const output = runScript("backup.sh", [], {
        DATABASE_URL,
        BACKUP_DIR: dir,
        BACKUP_RETENTION_DAYS: "0",
      });
      expect(output).toMatch(/same machine as the database/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("uploads a verified dump and checks what landed", () => {
    const dir = freshDir();
    const aws = stubAwsCli(dir);
    try {
      const output = runScript("backup.sh", [], {
        DATABASE_URL,
        BACKUP_DIR: dir,
        BACKUP_RETENTION_DAYS: "0",
        BACKUP_S3_BUCKET: "riai-backups",
        BACKUP_S3_PREFIX: "ledger",
        PATH: `${aws.binDir}:${process.env.PATH ?? ""}`,
      });

      expect(output).toMatch(/uploaded .*verified/i);

      const calls = aws.calls();
      const copy = calls.find((call) => call.join(" ").includes("s3 cp"));
      expect(copy?.join(" ")).toContain("s3://riai-backups/ledger/riai-");
      // The object is read back after it lands, for the same reason the dump
      // is read back before it is kept.
      expect(
        calls.some((call) => call.join(" ").includes("s3api head-object")),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("passes the endpoint through, so any S3-compatible store works", () => {
    // R2, Supabase and MinIO differ from S3 in exactly one thing.
    const dir = freshDir();
    const aws = stubAwsCli(dir);
    try {
      runScript("backup.sh", [], {
        DATABASE_URL,
        BACKUP_DIR: dir,
        BACKUP_RETENTION_DAYS: "0",
        BACKUP_S3_BUCKET: "riai-backups",
        BACKUP_S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
        PATH: `${aws.binDir}:${process.env.PATH ?? ""}`,
      });

      const copy = aws
        .calls()
        .find((call) => call.join(" ").includes("s3 cp"))
        ?.join(" ");
      expect(copy).toContain(
        "--endpoint-url https://account.r2.cloudflarestorage.com",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("fails the run when the upload fails, and prunes nothing", () => {
    // The failure that matters most: a nightly job that reports success while
    // nothing has gone offsite for a month.
    const dir = freshDir();
    const aws = stubAwsCli(dir, { failUpload: true });
    try {
      let failed = false;
      let output = "";
      try {
        runScript("backup.sh", [], {
          DATABASE_URL,
          BACKUP_DIR: dir,
          BACKUP_RETENTION_DAYS: "1",
          BACKUP_S3_BUCKET: "riai-backups",
          PATH: `${aws.binDir}:${process.env.PATH ?? ""}`,
        });
      } catch (error) {
        failed = true;
        output = String(
          (error as { stderr?: Buffer; stdout?: Buffer }).stderr ?? "",
        );
      }

      expect(failed).toBe(true);
      expect(output).toMatch(/upload failed/i);
      expect(output).toMatch(/nothing was pruned/i);

      // The local dump is still there. It is now the only copy, which is
      // exactly why it must not be deleted.
      expect(readdirSync(dir).some((name) => name.endsWith(".dump"))).toBe(
        true,
      );
      expect(aws.calls().some((call) => call.join(" ").includes("s3 rm"))).toBe(
        false,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("refuses an upload that landed the wrong size", () => {
    // A truncated object is the ordinary way an offsite backup turns out to be
    // worthless. It costs one request to notice, and the run has to fail —
    // otherwise the only signal is a restore that does not work.
    const dir = freshDir();
    const aws = stubAwsCli(dir, { reportedSize: "42" });
    try {
      let failed = false;
      let output = "";
      try {
        runScript("backup.sh", [], {
          DATABASE_URL,
          BACKUP_DIR: dir,
          BACKUP_RETENTION_DAYS: "0",
          BACKUP_S3_BUCKET: "riai-backups",
          PATH: `${aws.binDir}:${process.env.PATH ?? ""}`,
        });
      } catch (error) {
        failed = true;
        output = String((error as { stderr?: Buffer }).stderr ?? "");
      }

      expect(failed).toBe(true);
      expect(output).toMatch(/42 bytes, expected/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("prunes remote copies past the retention window, and only those", () => {
    const dir = freshDir();
    const aws = stubAwsCli(dir, {
      listKeys: [
        // Well past any sane window.
        "riai/riai-20200101T000000Z.dump",
        // Today's — must survive.
        `riai/riai-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z.dump`,
        // Not one of ours, and not ours to delete.
        "riai/notes.txt",
      ],
    });
    try {
      runScript("backup.sh", [], {
        DATABASE_URL,
        BACKUP_DIR: dir,
        BACKUP_RETENTION_DAYS: "14",
        BACKUP_S3_BUCKET: "riai-backups",
        PATH: `${aws.binDir}:${process.env.PATH ?? ""}`,
      });

      const removed = aws
        .calls()
        .filter((call) => call.join(" ").includes("s3 rm"))
        .map((call) => call.join(" "));

      expect(removed.join("\n")).toContain("riai-20200101T000000Z.dump");
      // A file it does not recognise is left alone. A retention job that
      // deletes what it cannot parse eventually deletes something it should not.
      expect(removed.join("\n")).not.toContain("notes.txt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
