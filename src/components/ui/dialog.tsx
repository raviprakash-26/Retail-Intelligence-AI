"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The last control focused outside a dialog.
 *
 * One listener for the whole page rather than one per dialog, and read only
 * when a dialog closes. Because anything inside a dialog is skipped, the value
 * still holds the control that opened the one currently on screen. That is an
 * assumption about this application rather than a general truth: it is right
 * while no dialog opens another, which none of the seventeen here do, and a
 * dialog inside a dialog would send focus to the wrong place on close.
 */
let lastFocusedOutsideDialog: HTMLElement | null = null;

function rememberFocus(event: FocusEvent) {
  const target = event.target as HTMLElement | null;
  if (target && !target.closest('[data-slot="dialog-content"]')) {
    lastFocusedOutsideDialog = target;
  }
}

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  React.useEffect(() => {
    document.addEventListener("focusin", rememberFocus, true);
    return () => document.removeEventListener("focusin", rememberFocus, true);
  }, []);

  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Closing a dialog puts focus back where it came from.
 *
 * Radix's modal content prevents the browser's own focus restoration and
 * focuses its `DialogTrigger` instead. Fifteen of the seventeen dialogs here
 * are opened from an ordinary button with controlled state rather than from a
 * `DialogTrigger`, so that ref is null, nothing is focused, and focus lands on
 * `<body>` — somebody who opened "Add customer" with a keyboard and pressed
 * Escape is returned to the top of the document and has to tab through the
 * sidebar and the search box to get back to where they were.
 *
 * Radix's own focus scope would have restored correctly, but it never gets the
 * chance twice over. It only records a previous element when focus is still
 * outside the dialog once its effect runs, and a dialog whose first field
 * carries `autoFocus` has already moved focus inside during commit — so it
 * records the field, which is detached by the time it would be focused again.
 * Then the modal wrapper prevents the default restoration regardless and
 * reaches for the trigger that is not there.
 *
 * So the control that opened it is taken from `lastFocusedOutsideDialog`,
 * which is recorded as focus moves rather than at any point in the dialog's
 * own lifecycle — every moment in that lifecycle is either too late or not
 * one a component may read the document in. Restoring is skipped if the
 * control has since left the page, because focusing a detached node does
 * nothing.
 */
function DialogContent({
  className,
  children,
  showCloseButton = true,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (event.defaultPrevented) return;
          const target = lastFocusedOutsideDialog;
          if (!target?.isConnected) return;
          // Preventing the default is what stops the modal wrapper reaching
          // for a trigger that is not there; this replaces it.
          event.preventDefault();
          target.focus();
        }}
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-xl border bg-background p-6 shadow-lg data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            className="absolute top-4 right-4 rounded-md opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none"
            aria-label="Close"
          >
            <X className="size-4" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-1.5 text-left", className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "text-lg leading-none font-semibold tracking-tight",
        className,
      )}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm leading-relaxed text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogTitle,
  DialogTrigger,
};
