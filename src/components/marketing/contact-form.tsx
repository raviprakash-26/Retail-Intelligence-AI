"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Send } from "lucide-react";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { siteConfig } from "@/config/site";

const TOPICS = [
  { value: "sales", label: "Plans and pricing", email: siteConfig.salesEmail },
  {
    value: "migration",
    label: "Moving from another system",
    email: siteConfig.salesEmail,
  },
  {
    value: "support",
    label: "Help with my account",
    email: siteConfig.supportEmail,
  },
  {
    value: "practice",
    label: "I am an accountant with several clients",
    email: siteConfig.salesEmail,
  },
  { value: "other", label: "Something else", email: siteConfig.supportEmail },
] as const;

const contactSchema = z.object({
  name: z.string().trim().min(2, "Please enter your name."),
  email: z.email("Please enter a valid email address."),
  business: z.string().trim().optional(),
  topic: z.string().min(1, "Please choose a topic."),
  message: z
    .string()
    .trim()
    .min(20, "Please give us a little more detail (at least 20 characters).")
    .max(2000, "Please keep the message under 2000 characters."),
});

type ContactValues = z.infer<typeof contactSchema>;

/**
 * Contact form.
 *
 * There is no message-ingestion endpoint yet, so rather than post to a stub
 * that returns a fabricated success, the form composes the message and hands
 * it to the visitor's mail client. The submission genuinely happens — it just
 * happens over email until the backend lands.
 */
export function ContactForm() {
  const form = useForm<ContactValues>({
    resolver: zodResolver(contactSchema),
    defaultValues: {
      name: "",
      email: "",
      business: "",
      topic: "",
      message: "",
    },
  });

  const [handedOff, setHandedOff] = React.useState(false);

  function onSubmit(values: ContactValues) {
    const topic = TOPICS.find((item) => item.value === values.topic);
    const subject = `[${topic?.label ?? "Enquiry"}] ${values.name}`;
    const body = [
      `Name: ${values.name}`,
      `Email: ${values.email}`,
      values.business ? `Business: ${values.business}` : null,
      `Topic: ${topic?.label ?? values.topic}`,
      "",
      values.message,
    ]
      .filter(Boolean)
      .join("\n");

    const href = `mailto:${topic?.email ?? siteConfig.supportEmail}?subject=${encodeURIComponent(
      subject,
    )}&body=${encodeURIComponent(body)}`;

    window.location.assign(href);
    setHandedOff(true);
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Your name</FormLabel>
                <FormControl>
                  <Input
                    placeholder="Ravi Prakash"
                    autoComplete="name"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

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
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="business"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Business name (optional)</FormLabel>
              <FormControl>
                <Input
                  placeholder="Ravi Retail Mart"
                  autoComplete="organization"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="topic"
          render={({ field }) => (
            <FormItem>
              <FormLabel>What is this about?</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a topic" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {TOPICS.map((topic) => (
                    <SelectItem key={topic.value} value={topic.value}>
                      {topic.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="message"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Message</FormLabel>
              <FormControl>
                <textarea
                  rows={5}
                  placeholder="Tell us what you are using today and what is not working."
                  className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-xs transition-[color,box-shadow,border-color] outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25 aria-invalid:border-destructive aria-invalid:ring-destructive/20"
                  {...field}
                />
              </FormControl>
              <FormDescription>
                Please do not include passwords, card details or GST portal
                credentials in this message.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <Button type="submit" size="lg" className="w-full">
          <Send className="size-4" />
          Compose message
        </Button>

        <p
          className="text-xs leading-relaxed text-muted-foreground"
          aria-live="polite"
        >
          {handedOff
            ? "Your email client should have opened with the message ready to send. If nothing happened, email us directly at " +
              siteConfig.supportEmail +
              "."
            : "This opens your email client with the message prepared, so you keep a copy of what you sent."}
        </p>
      </form>
    </Form>
  );
}
