"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Mail } from "lucide-react";
import { AuthBackendNotice } from "@/components/auth/phase-notice";
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

export function ForgotPasswordForm() {
  const form = useForm<ForgotPasswordInput>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: "" },
  });

  const [submitted, setSubmitted] = React.useState(false);

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(() => setSubmitted(true))}
        className="space-y-5"
      >
        {submitted && <AuthBackendNotice action="sending the reset email" />}

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
              {/* The live implementation returns the same response whether or
                  not the address exists, so this screen must not promise an
                  email will definitely arrive. */}
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
        >
          <Mail className="size-4" />
          Send reset link
        </Button>
      </form>
    </Form>
  );
}
