"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Ban } from "lucide-react";
import { z } from "zod";
import { FormError } from "@/components/auth/form-error";
import { useServerFormErrors } from "@/components/auth/use-action-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/server/auth/action-result";

/**
 * Voiding a posted document.
 *
 * A reason is required and stored, because "why is bill BILL-0042 not in the
 * purchases figure" is a question someone will eventually have to answer. The
 * dialog says plainly what voiding does — nothing is deleted — so nobody
 * reaches for it expecting the document to disappear.
 *
 * Shared by invoices and bills: the wording differs, the guarantee does not.
 */

const schema = z.object({
  reason: z
    .string()
    .trim()
    .min(5, "Say why this is being voided.")
    .max(300, "Keep the reason under 300 characters."),
});

type VoidValues = z.infer<typeof schema>;

export function VoidDocumentDialog({
  documentId,
  documentNumber,
  noun,
  onVoid,
  placeholder = "Entered twice by mistake",
  description,
}: {
  documentId: string;
  documentNumber: string;
  /** "invoice", "bill", "receipt", "payment". */
  noun: string;
  onVoid: (
    id: string,
    values: VoidValues,
  ) => Promise<ActionResult<{ entryNumber: string }>>;
  placeholder?: string;
  /**
   * What voiding this particular kind of document undoes. The default speaks
   * of stock, which is true of an invoice and a bill and untrue of a receipt —
   * telling someone their stock will be put back when no stock moved is worse
   * than saying nothing.
   */
  description?: React.ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  const form = useForm<VoidValues>({
    resolver: zodResolver(schema),
    defaultValues: { reason: "" },
  });
  const { formError, applyResult } = useServerFormErrors(form);

  async function onSubmit(values: VoidValues) {
    const result = await onVoid(documentId, values);
    if (!applyResult(result)) return;
    setOpen(false);
    form.reset({ reason: "" });
    router.refresh();
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Ban className="size-4" />
        Void {noun}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Void {documentNumber}?</DialogTitle>
            <DialogDescription>
              {description ?? (
                <>
                  The {noun}, its journal entry and its stock movements all stay
                  exactly where they are. A reversing entry is posted beside
                  them and the stock is put back, so the books show both that
                  this happened and that it was undone.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
              <FormError message={formError} />

              <FormField
                control={form.control}
                name="reason"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Why is it being voided?</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={3}
                        autoFocus
                        placeholder={placeholder}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setOpen(false)}
                >
                  Keep it
                </Button>
                <Button
                  type="submit"
                  variant="destructive"
                  loading={form.formState.isSubmitting}
                  loadingText="Voiding…"
                >
                  Void {noun}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </>
  );
}
