"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Ban } from "lucide-react";
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
import { voidSaleSchema, type VoidSaleInput } from "@/lib/validation/sales";
import { voidSaleAction } from "@/server/sales/actions";

/**
 * Voiding an invoice.
 *
 * A reason is required and it is stored, because "why is invoice INV-0042 not
 * in the turnover" is a question someone will eventually have to answer. The
 * dialog says plainly what voiding does — nothing is deleted — so nobody
 * reaches for it expecting the invoice to disappear.
 */
export function VoidInvoiceDialog({
  saleId,
  invoiceNumber,
}: {
  saleId: string;
  invoiceNumber: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  const form = useForm<VoidSaleInput>({
    resolver: zodResolver(voidSaleSchema),
    defaultValues: { reason: "" },
  });
  const { formError, applyResult } = useServerFormErrors(form);

  async function onSubmit(values: VoidSaleInput) {
    const result = await voidSaleAction(saleId, values);
    if (!applyResult(result)) return;
    setOpen(false);
    form.reset({ reason: "" });
    router.refresh();
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Ban className="size-4" />
        Void invoice
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Void {invoiceNumber}?</DialogTitle>
            <DialogDescription>
              The invoice, its journal entry and its stock movements all stay
              exactly where they are. A reversing entry is posted beside them and
              the stock goes back, so the books show both that the sale happened
              and that it was undone.
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
                        placeholder="Entered twice by mistake"
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
                  Void invoice
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </>
  );
}
