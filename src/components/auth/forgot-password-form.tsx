"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Mail, MailCheck } from "lucide-react";
import { FormError } from "@/components/auth/form-error";
import { useServerFormErrors } from "@/components/auth/use-action-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  forgotPasswordSchema,
  type ForgotPasswordInput,
} from "@/lib/validation/auth";
import { forgotPasswordAction } from "@/server/auth/actions";

export function ForgotPasswordForm() {
  const form = useForm<ForgotPasswordInput>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: "" },
  });

  const { formError, retryAfterSeconds, applyResult } =
    useServerFormErrors(form);
  const [sentTo, setSentTo] = React.useState<string | null>(null);

  async function onSubmit(values: ForgotPasswordInput) {
    const result = await forgotPasswordAction(values);
    if (!applyResult(result)) return;
    setSentTo(values.email);
  }

  // The confirmation is deliberately identical whether or not the address is
  // registered — the server does not tell us, precisely so this screen cannot.
  if (sentTo) {
    return (
      <Alert variant="success">
        <MailCheck />
        <AlertTitle>Check your inbox</AlertTitle>
        <AlertDescription>
          <p>
            If an account exists for <strong>{sentTo}</strong>, a reset link is
            on its way. It expires in one hour and can only be used once.
          </p>
          <p className="text-xs opacity-80">
            Nothing arrived? Check your spam folder, or try again in a few
            minutes.
          </p>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
        <FormError message={formError} retryAfterSeconds={retryAfterSeconds} />

        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input
                  type="email"
                  placeholder="you@business.com"
                  autoComplete="email"
                  autoFocus
                  {...field}
                />
              </FormControl>
              <FormDescription>
                If an account exists for this address, a reset link will be sent
                to it. The link expires in one hour.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <Button
          type="submit"
          size="lg"
          className="w-full"
          loading={form.formState.isSubmitting}
          loadingText="Sending…"
        >
          <Mail className="size-4" />
          Send reset link
        </Button>
      </form>
    </Form>
  );
}
