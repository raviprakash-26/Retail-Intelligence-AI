"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { KeyRound } from "lucide-react";
import { AuthBackendNotice } from "@/components/auth/phase-notice";
import { PasswordField } from "@/components/auth/password-field";
import { PasswordStrengthMeter } from "@/components/auth/password-strength";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  resetPasswordSchema,
  type ResetPasswordInput,
} from "@/lib/validation/auth";

export function ResetPasswordForm({ token }: { token: string }) {
  const form = useForm<ResetPasswordInput>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { token, password: "", confirmPassword: "" },
  });

  const password = form.watch("password");
  const [submitted, setSubmitted] = React.useState(false);

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(() => setSubmitted(true))}
        className="space-y-5"
      >
        {submitted && <AuthBackendNotice action="setting your new password" />}

        <input type="hidden" {...form.register("token")} />

        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>New password</FormLabel>
              <FormControl>
                <PasswordField
                  placeholder="At least 10 characters"
                  autoComplete="new-password"
                  autoFocus
                  {...field}
                />
              </FormControl>
              <PasswordStrengthMeter password={password} />
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="confirmPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Confirm new password</FormLabel>
              <FormControl>
                <PasswordField
                  placeholder="Re-enter your new password"
                  autoComplete="new-password"
                  {...field}
                />
              </FormControl>
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
          <KeyRound className="size-4" />
          Set new password
        </Button>

        {/* Changing a password invalidates every existing session, so the user
            should not be surprised to be signed out on their other devices. */}
        <p className="text-xs leading-relaxed text-muted-foreground">
          Setting a new password signs you out everywhere else. You will need to
          sign in again on your other devices.
        </p>
      </form>
    </Form>
  );
}
