import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { seedPermissionsAndRoles } from "./seed/permissions";
import { seedSubscriptionPlans } from "./seed/plans";
import { DEMO, seedDemoCompany } from "./seed/demo-company";

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

const envFile = process.env.NODE_ENV === "test" ? ".env.test" : ".env";
process.loadEnvFile?.(path.join(process.cwd(), envFile));

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

  if (!shouldSeedDemo()) {
    console.log(
      "→ Skipping demo data (set SEED_DEMO_DATA=true to include it).",
    );
    console.log(`✔ Seed complete in ${Date.now() - startedAt}ms`);
    return;
  }

  console.log("→ Seeding demo tenant…");
  const demo = await seedDemoCompany(prisma, new Date());

  console.log(`  ✓ Ravi Retail Mart provisioned (${demo.companyId})`);
  console.log(
    `  ✓ ${demo.products} products, ${demo.customers} customers, ${demo.suppliers} suppliers, ${demo.employees} employees`,
  );
  console.log(
    `  ✓ Opening entry ${demo.openingEntry} posted and balanced at ₹${demo.openingTotal}`,
  );
  console.log("");
  console.log("  Demo sign-in (development only):");
  console.log(`    Owner       ${DEMO.ownerEmail}`);
  console.log(`    Accountant  ${DEMO.accountantEmail}`);
  console.log(`    Cashier     ${DEMO.cashierEmail}`);
  console.log(`    Password    ${DEMO.password}`);
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
