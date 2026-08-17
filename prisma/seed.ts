import { existsSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { seedPermissionsAndRoles } from "./seed/permissions";
import { seedSubscriptionPlans } from "./seed/plans";
import { DEMO, seedDemoCompany } from "./seed/demo-company";
import { demoOpenedOn, seedDemoTrading } from "./seed/demo-trading";
import { PLATFORM_ADMIN, seedPlatformAdmin } from "./seed/platform-admin";

/**
 * Database seed.
 *
 * Two layers, deliberately separate:
 *
 *   Platform data (permissions, system roles, subscription plans) is required
 *   for the application to function and is seeded in every environment,
 *   including production. It is idempotent.
 *
 *   Demo data (the Ravi Retail Mart tenant) is development-only. It refuses to
 *   run against a production NODE_ENV unless explicitly forced, because
 *   creating a tenant with published credentials on a live system would be a
 *   security incident.
 */

// Loaded only if present. These files are gitignored, so they exist on a
// developer's machine and nowhere else; anywhere that supplies configuration
// as real environment variables — a container, CI — has none to read.
const envFile = process.env.NODE_ENV === "test" ? ".env.test" : ".env";
const envPath = path.join(process.cwd(), envFile);
if (existsSync(envPath)) {
  process.loadEnvFile?.(envPath);
}

const prisma = new PrismaClient();

function shouldSeedDemo(): boolean {
  const flag = process.env.SEED_DEMO_DATA;
  const explicit = flag === "true" || flag === "1";

  if (process.env.NODE_ENV === "production") {
    if (explicit && process.env.SEED_DEMO_FORCE === "true") {
      console.warn(
        "⚠️  Seeding demo data into a production environment because SEED_DEMO_FORCE=true.",
      );
      return true;
    }
    return false;
  }

  // Convenient default outside production: a fresh checkout has something to
  // look at without extra steps.
  return flag === undefined ? true : explicit;
}

async function main() {
  const startedAt = Date.now();
  console.log("→ Seeding platform data…");

  const permissions = await seedPermissionsAndRoles(prisma);
  console.log(
    `  ✓ ${permissions.permissions} permissions, ${permissions.roles} system roles`,
  );

  const plans = await seedSubscriptionPlans(prisma);
  console.log(`  ✓ ${plans.plans} subscription plans`);

  const admin = await seedPlatformAdmin(prisma);
  if (admin) {
    console.log(`  ✓ platform administrator (${PLATFORM_ADMIN.email})`);
  }

  if (!shouldSeedDemo()) {
    console.log(
      "→ Skipping demo data (set SEED_DEMO_DATA=true to include it).",
    );
    console.log(`✔ Seed complete in ${Date.now() - startedAt}ms`);
    return;
  }

  console.log("→ Seeding demo tenant…");
  const asOf = new Date();
  // The demo shop has been trading for months, so it opened its books before
  // its earliest invoice — otherwise that invoice falls outside its calendar.
  const demo = await seedDemoCompany(prisma, asOf, demoOpenedOn(asOf));

  // A shop that has never traded shows a blank dashboard, an empty ageing and
  // AI modules with nothing to read. The history is posted through the
  // ordinary services, so the books balance because the engine balanced them.
  const trading = await seedDemoTrading(
    prisma,
    demo.companyId,
    demo.ownerId,
    asOf,
  );

  console.log(`  ✓ Ravi Retail Mart provisioned (${demo.companyId})`);
  console.log(
    `  ✓ ${demo.products} products, ${demo.customers} customers, ${demo.suppliers} suppliers, ${demo.employees} employees`,
  );
  console.log(
    `  ✓ Opening entry ${demo.openingEntry} posted and balanced at ₹${demo.openingTotal}`,
  );
  console.log(
    `  ✓ ${trading.purchases} bills, ${trading.sales} invoices, ${trading.receipts} receipts, ${trading.payments} payments, ${trading.expenses} expenses, ${trading.returns} credit note`,
  );
  console.log("");
  console.log("  Demo sign-in (development only):");
  console.log(`    Owner       ${DEMO.ownerEmail}`);
  console.log(`    Accountant  ${DEMO.accountantEmail}`);
  console.log(`    Cashier     ${DEMO.cashierEmail}`);
  console.log(`    Password    ${DEMO.password}`);
  if (admin) {
    console.log("");
    console.log("  Platform administration (development only):");
    console.log(`    Admin       ${PLATFORM_ADMIN.email}`);
    console.log(`    Password    ${PLATFORM_ADMIN.password}`);
  }
  console.log("");
  console.log(`✔ Seed complete in ${Date.now() - startedAt}ms`);
}

main()
  .catch((error) => {
    console.error("✖ Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
