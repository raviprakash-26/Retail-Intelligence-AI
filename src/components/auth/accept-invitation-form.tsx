"use client";

import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight } from "lucide-react";
import { FormError } from "@/components/auth/form-error";
import { PasswordField } from "@/components/auth/password-field";
import { PasswordStrengthMeter } from "@/components/auth/password-strength";
import { useServerFormErrors } from "@/components/auth/use-action-form";
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
  acceptInvitationSchema,
  type AcceptInvitationInput,
} from "@/lib/validation/company";
import { acceptInvitationAction } from "@/server/company/actions";

export function AcceptInvitationForm({
  token,
  fullName,
  hasAccount,
}: {
  token: string;
  fullName: string;
  /** An existing account keeps its password; the field then only confirms identity. */
  hasAccount: boolean;
}) {
  const router = useRouter();

  const form = useForm<AcceptInvitationInput>({
    resolver: zodResolver(acceptInvitationSchema),
    defaultValues: {
      token,
      fullName,
      mobile: "",
      password: "",
      confirmPassword: "",
    },
  });

  const { formError, retryAfterSeconds, applyResult } =
    useServerFormErrors(form);
  const password = form.watch("password");

  async function onSubmit(values: AcceptInvitationInput) {
    const result = await acceptInvitationAction(values);
    if (!applyResult(result)) return;
    router.replace(result.data.redirectTo);
    router.refresh();
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
        <FormError message={formError} retryAfterSeconds={retryAfterSeconds} />

        <input type="hidden" {...form.register("token")} />

        <FormField
          control={form.control}
          name="fullName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Your name</FormLabel>
              <FormControl>
                <Input autoComplete="name" disabled={hasAccount} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {!hasAccount && (
          <FormField
            control={form.control}
            name="mobile"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Mobile number
                  <span className="font-normal text-muted-foreground">
                    (optional)
                  </span>
                </FormLabel>
                <FormControl>
                  <Input
                    type="tel"
                    inputMode="tel"
                    placeholder="98765 43210"
                    autoComplete="tel"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                {hasAccount ? "Your existing password" : "Choose a password"}
              </FormLabel>
              <FormControl>
                <PasswordField
                  placeholder={
                    hasAccount ? "Your password" : "At least 10 characters"
                  }
                  autoComplete={
                    hasAccount ? "current-password" : "new-password"
                  }
                  {...field}
                />
              </FormControl>
              {hasAccount ? (
                <FormDescription>
                  You already have an account, so this just confirms it is you.
                  Your password will not change.
                </FormDescription>
              ) : (
                <PasswordStrengthMeter password={password} name={fullName} />
              )}
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="confirmPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Confirm password</FormLabel>
              <FormControl>
                <PasswordField
                  placeholder="Re-enter your password"
                  autoComplete={
                    hasAccount ? "current-password" : "new-password"
                  }
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
          loadingText="Joining…"
        >
          Accept invitation
          <ArrowRight className="size-4" />
        </Button>
      </form>
    </Form>
  );
}
