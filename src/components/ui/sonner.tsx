"use client";

import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * Toast host. Mounted once in the root layout.
 *
 * Toasts carry transient confirmations ("Invoice INV-0042 posted"). They are
 * never the only place a financial outcome is reported — anything that matters
 * also updates the page or writes an audit log entry, because a toast that is
 * missed is gone.
 */
function Toaster({ ...props }: ToasterProps) {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      position="bottom-right"
      closeButton
      richColors={false}
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-popover group-[.toaster]:text-popover-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg group-[.toaster]:rounded-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-secondary group-[.toast]:text-secondary-foreground",
          error: "group-[.toaster]:border-destructive/30",
          success: "group-[.toaster]:border-success/30",
          warning: "group-[.toaster]:border-warning/30",
          info: "group-[.toaster]:border-info/30",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
