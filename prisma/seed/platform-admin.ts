import { PlatformRole, UserStatus, type PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

/**
 * The platform administrator.
 *
 * Somebody has to be able to run the service — see who has signed up, change
 * what a plan costs, suspend an account that is abusing it. Without a seeded
 * administrator the admin panel is unreachable on a fresh install and the first
 * one has to be made with a SQL statement, which is worse than a documented
 * development account.
 *
 * This is **development-only**, for the same reason the demo tenant is: an
 * account with a published password and platform-wide reach is a security
 * incident on a live system, not a convenience. The seed refuses to create it
 * outside development unless explicitly forced, and even then it warns.
 *
 * The account it creates holds no tenant membership. A platform administrator
 * is not a member of anybody's business, and cannot read one's books from here
 * — see `lib/admin/scope.ts`.
 */

export const PLATFORM_ADMIN = {
  email: "admin@retailintelligence.local",
  /** Published in the README. Development only. */
  password: "AdminRetail@2026",
  fullName: "Platform Administrator",
} as const;

export async function seedPlatformAdmin(
  prisma: PrismaClient,
): Promise<{ userId: string } | null> {
  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction && process.env.SEED_ADMIN_FORCE !== "true") {
    console.log(
      "→ Skipping the development administrator (production environment).",
    );
    return null;
  }
  if (isProduction) {
    console.warn(
      "⚠️  Creating a platform administrator with a published password in production because SEED_ADMIN_FORCE=true.",
    );
  }

  const passwordHash = await bcrypt.hash(PLATFORM_ADMIN.password, 12);

  const user = await prisma.user.upsert({
    where: { email: PLATFORM_ADMIN.email },
    update: { platformRole: PlatformRole.SUPER_ADMIN },
    create: {
      email: PLATFORM_ADMIN.email,
      fullName: PLATFORM_ADMIN.fullName,
      passwordHash,
      status: UserStatus.ACTIVE,
      emailVerifiedAt: new Date(),
      platformRole: PlatformRole.SUPER_ADMIN,
    },
    select: { id: true },
  });

  return { userId: user.id };
}
