import "server-only";
import { prisma } from "@/lib/db";

/**
 * Notifications.
 *
 * A notification is addressed either to one member or to the whole company
 * (`userId` null). Reads are always scoped by companyId *and* by "mine or
 * everyone's", so one member cannot see another's private alerts.
 */

export type NotificationItem = {
  id: string;
  type: string;
  severity: "INFO" | "SUCCESS" | "WARNING" | "DANGER";
  title: string;
  body: string;
  actionUrl: string | null;
  readAt: Date | null;
  createdAt: Date;
};

export async function listNotifications(params: {
  companyId: string;
  userId: string;
  limit?: number;
}): Promise<NotificationItem[]> {
  return prisma.notification.findMany({
    where: {
      companyId: params.companyId,
      OR: [{ userId: params.userId }, { userId: null }],
    },
    select: {
      id: true,
      type: true,
      severity: true,
      title: true,
      body: true,
      actionUrl: true,
      readAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: params.limit ?? 20,
  });
}

export async function countUnread(params: {
  companyId: string;
  userId: string;
}): Promise<number> {
  return prisma.notification.count({
    where: {
      companyId: params.companyId,
      OR: [{ userId: params.userId }, { userId: null }],
      readAt: null,
    },
  });
}

/**
 * Marks notifications read.
 *
 * The company and recipient conditions are part of the update filter, not
 * checked beforehand, so a forged id simply matches nothing.
 */
export async function markRead(params: {
  companyId: string;
  userId: string;
  notificationIds?: string[];
}): Promise<number> {
  const result = await prisma.notification.updateMany({
    where: {
      companyId: params.companyId,
      OR: [{ userId: params.userId }, { userId: null }],
      readAt: null,
      ...(params.notificationIds ? { id: { in: params.notificationIds } } : {}),
    },
    data: { readAt: new Date() },
  });
  return result.count;
}
