"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { Bell, BellOff, CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatRelativeTime } from "@/lib/format";
import { markNotificationsReadAction } from "@/server/search/actions";
import { cn } from "@/lib/utils";

export type NotificationView = {
  id: string;
  severity: "INFO" | "SUCCESS" | "WARNING" | "DANGER";
  title: string;
  body: string;
  actionUrl: string | null;
  readAt: string | null;
  createdAt: string;
};

const SEVERITY_DOT: Record<NotificationView["severity"], string> = {
  INFO: "bg-info",
  SUCCESS: "bg-success",
  WARNING: "bg-warning",
  DANGER: "bg-destructive",
};

export function NotificationsMenu({
  notifications,
  unreadCount,
}: {
  notifications: NotificationView[];
  unreadCount: number;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);

  async function markAllRead() {
    setPending(true);
    try {
      await markNotificationsReadAction();
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative text-muted-foreground hover:text-foreground"
          aria-label={
            unreadCount > 0
              ? `Notifications, ${unreadCount} unread`
              : "Notifications"
          }
        >
          <Bell className="size-4" />
          {unreadCount > 0 && (
            <span className="tabular-figures absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-destructive text-[0.5625rem] font-semibold text-destructive-foreground">
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2.5">
          <p className="text-sm font-semibold">Notifications</p>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={markAllRead}
              loading={pending}
              className="h-7 text-xs"
            >
              <CheckCheck className="size-3.5" />
              Mark all read
            </Button>
          )}
        </div>

        {notifications.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <BellOff
              className="size-5 text-muted-foreground"
              aria-hidden="true"
            />
            <p className="text-sm font-medium">Nothing to report</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Low stock, GST deadlines, overdue payments and audit findings will
              appear here as those modules come online.
            </p>
          </div>
        ) : (
          <ul className="max-h-96 divide-y overflow-y-auto">
            {notifications.map((notification) => {
              const content = (
                <>
                  <span
                    className={cn(
                      "mt-1.5 size-1.5 shrink-0 rounded-full",
                      SEVERITY_DOT[notification.severity],
                      notification.readAt && "opacity-30",
                    )}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block text-sm",
                        notification.readAt ? "font-normal" : "font-medium",
                      )}
                    >
                      {notification.title}
                    </span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                      {notification.body}
                    </span>
                    <span className="mt-1 block text-[0.6875rem] text-muted-foreground">
                      {formatRelativeTime(notification.createdAt)}
                    </span>
                  </span>
                </>
              );

              return (
                <li key={notification.id}>
                  {notification.actionUrl ? (
                    <a
                      href={notification.actionUrl as Route}
                      className="flex gap-2.5 px-3 py-3 transition-colors hover:bg-secondary"
                    >
                      {content}
                    </a>
                  ) : (
                    <div className="flex gap-2.5 px-3 py-3">{content}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
