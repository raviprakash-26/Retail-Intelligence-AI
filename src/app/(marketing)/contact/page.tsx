import type { Metadata } from "next";
import { Building2, LifeBuoy, Mail, ShieldCheck } from "lucide-react";
import { Section, SectionHeading } from "@/components/marketing/section";
import { ContactForm } from "@/components/marketing/contact-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { siteConfig } from "@/config/site";

export const metadata: Metadata = {
  title: "Contact",
  description:
    "Get in touch with the Retail Intelligence AI team about sales, support or security.",
};

const CHANNELS = [
  {
    icon: Mail,
    title: "Sales",
    description:
      "Plans, migration from an existing system, and multi-branch setups.",
    value: siteConfig.salesEmail,
    href: `mailto:${siteConfig.salesEmail}`,
  },
  {
    icon: LifeBuoy,
    title: "Support",
    description:
      "Questions about your account, your data or a figure that looks wrong.",
    value: siteConfig.supportEmail,
    href: `mailto:${siteConfig.supportEmail}`,
  },
  {
    icon: ShieldCheck,
    title: "Security",
    description:
      "Responsible disclosure of a vulnerability. We respond to every report.",
    value: "security@retailintelligence.ai",
    href: "mailto:security@retailintelligence.ai",
  },
  {
    icon: Building2,
    title: "Accounting practices",
    description:
      "Managing several retail clients? Ask us about practice packaging.",
    value: siteConfig.salesEmail,
    href: `mailto:${siteConfig.salesEmail}`,
  },
];

export default function ContactPage() {
  return (
    <>
      <Section className="pb-10">
        <SectionHeading
          eyebrow="Contact"
          title="Talk to a person about your books."
          description="Tell us what you are running today and what is not working. We will tell you honestly whether this is the right fit."
        />
      </Section>

      <Section className="py-0 pb-20 lg:pb-28">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.1fr]">
          <div className="space-y-4">
            {CHANNELS.map((channel) => (
              <Card key={channel.title} className="card-hover">
                <CardHeader>
                  <div className="flex items-start gap-3.5">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-muted text-primary">
                      <channel.icon className="size-4.5" aria-hidden="true" />
                    </div>
                    <div className="min-w-0">
                      <CardTitle className="text-sm">{channel.title}</CardTitle>
                      <CardDescription className="mt-1 leading-relaxed">
                        {channel.description}
                      </CardDescription>
                      <a
                        href={channel.href}
                        className="mt-2 inline-block text-sm font-medium text-primary underline-offset-4 hover:underline"
                      >
                        {channel.value}
                      </a>
                    </div>
                  </div>
                </CardHeader>
              </Card>
            ))}
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Send us a message</CardTitle>
              <CardDescription>
                We reply to every message within one business day.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ContactForm />
            </CardContent>
          </Card>
        </div>
      </Section>
    </>
  );
}
