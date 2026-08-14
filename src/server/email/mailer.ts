import "server-only";
import { env } from "@/lib/env";

/**
 * Outbound email.
 *
 * An abstraction with a console driver so the whole verification and
 * password-reset flow is exercisable in development without an SMTP account.
 * The console driver prints the link; it never silently pretends to have sent
 * something, because a reset flow that appears to work and does not is worse
 * than one that visibly does not.
 *
 * SMTP and Resend drivers are wired in Phase 25 alongside the deliverability
 * configuration (SPF, DKIM, bounce handling) they need to be useful.
 */

export type EmailMessage = {
  to: string;
  subject: string;
  /** Plain text is the source of truth; HTML is a nicety. */
  text: string;
  html?: string;
};

export type EmailResult =
  | { delivered: true; driver: string }
  | { delivered: false; driver: string; reason: string };

interface Mailer {
  send(message: EmailMessage): Promise<EmailResult>;
}

class ConsoleMailer implements Mailer {
  async send(message: EmailMessage): Promise<EmailResult> {
    // Deliberately console.info rather than a logger: this is a development
    // affordance, and it should be impossible to miss in the terminal.
    console.warn(
      [
        "",
        "──────────────────────────────────────────────────────────────",
        "  EMAIL (console driver — not actually sent)",
        "──────────────────────────────────────────────────────────────",
        `  To:      ${message.to}`,
        `  From:    ${env.EMAIL_FROM}`,
        `  Subject: ${message.subject}`,
        "──────────────────────────────────────────────────────────────",
        message.text,
        "──────────────────────────────────────────────────────────────",
        "",
      ].join("\n"),
    );
    return { delivered: true, driver: "console" };
  }
}

class UnconfiguredMailer implements Mailer {
  constructor(private readonly driver: string) {}

  async send(message: EmailMessage): Promise<EmailResult> {
    const reason = `The "${this.driver}" email driver is selected but not implemented yet.`;
    console.error(`Email not sent to ${message.to}: ${reason}`);
    return { delivered: false, driver: this.driver, reason };
  }
}

function mailer(): Mailer {
  switch (env.EMAIL_DRIVER) {
    case "console":
      return new ConsoleMailer();
    default:
      return new UnconfiguredMailer(env.EMAIL_DRIVER);
  }
}

export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  return mailer().send(message);
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function absoluteUrl(path: string): string {
  return new URL(path, env.APP_URL).toString();
}

export function verificationEmail(params: {
  to: string;
  name: string;
  token: string;
}): EmailMessage {
  const link = absoluteUrl(
    `/verify-email?token=${encodeURIComponent(params.token)}`,
  );

  return {
    to: params.to,
    subject: "Confirm your email address",
    text: [
      `Hello ${params.name},`,
      "",
      "Confirm your email address to finish setting up your Retail Intelligence AI account:",
      "",
      link,
      "",
      "This link expires in 24 hours.",
      "",
      "If you did not create an account, you can ignore this message — nothing will happen.",
    ].join("\n"),
  };
}

export function passwordResetEmail(params: {
  to: string;
  name: string;
  token: string;
}): EmailMessage {
  const link = absoluteUrl(
    `/reset-password?token=${encodeURIComponent(params.token)}`,
  );

  return {
    to: params.to,
    subject: "Reset your password",
    text: [
      `Hello ${params.name},`,
      "",
      "Use this link to set a new password:",
      "",
      link,
      "",
      "The link expires in one hour and can only be used once.",
      "Setting a new password signs you out on every other device.",
      "",
      "If you did not ask for this, you can ignore this message. Your password has not changed.",
    ].join("\n"),
  };
}

export function invitationEmail(params: {
  to: string;
  name: string;
  inviterName: string;
  companyName: string;
  roleName: string;
  token: string;
  hasAccount: boolean;
}): EmailMessage {
  const link = absoluteUrl(
    `/invitation?token=${encodeURIComponent(params.token)}`,
  );

  return {
    to: params.to,
    subject: `${params.inviterName} invited you to ${params.companyName}`,
    text: [
      `Hello ${params.name},`,
      "",
      `${params.inviterName} has invited you to join ${params.companyName} on Retail Intelligence AI as ${article(params.roleName)} ${params.roleName}.`,
      "",
      params.hasAccount
        ? "You already have an account, so accepting just adds this business to it:"
        : "Accept the invitation and choose a password to get started:",
      "",
      link,
      "",
      "This invitation expires in 7 days.",
      "",
      "If you were not expecting this, you can ignore this message — no account will be created and nothing will be shared with you.",
    ].join("\n"),
  };
}

/** "an Accountant" / "a Cashier" — small thing, but it reads wrong otherwise. */
function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

/**
 * Sent when a reset is requested for an address with no account.
 *
 * The reset endpoint returns the same response either way, so an attacker
 * cannot use it to discover which addresses are registered. Telling the real
 * owner of the address that someone tried is useful, and costs nothing.
 */
export function passwordResetUnknownAccountEmail(to: string): EmailMessage {
  return {
    to,
    subject: "Password reset requested",
    text: [
      "Someone asked to reset the password for a Retail Intelligence AI account using this email address.",
      "",
      "There is no account registered to it, so there is nothing to reset.",
      "",
      "If this was you, you may have signed up with a different address.",
      "If it was not, you can safely ignore this message.",
    ].join("\n"),
  };
}
