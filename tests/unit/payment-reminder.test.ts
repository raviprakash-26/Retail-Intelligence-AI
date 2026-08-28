import { describe, expect, it } from "vitest";
import { paymentReminderEmail } from "@/server/settlements/payment-reminder";
import type { ReminderPreview } from "@/server/settlements/payment-reminder";

/**
 * Asking a customer for money.
 *
 * The thing being protected is restraint. A reminder is the shop speaking in
 * its own name to somebody it wants to keep as a customer, and this product
 * does not know what their arrangement is — so the message states what is owed
 * and stops. Interest, penalties, and threats about what happens next would all
 * be inventions, and an invented consequence in a shop's name is worse than no
 * reminder at all.
 */

function preview(overrides: Partial<ReminderPreview> = {}): ReminderPreview {
  return {
    customer: {
      id: "c1",
      name: "Sharma Provision Store",
      email: "accounts@sharma.example",
    },
    invoices: [
      {
        id: "s1",
        number: "INV-0001",
        date: "2026-05-02",
        dueDate: "2026-06-01",
        total: "12500.0000",
        paid: "0",
        outstanding: "12500.0000",
        daysOverdue: 76,
      },
      {
        id: "s2",
        number: "INV-0009",
        date: "2026-07-20",
        dueDate: "2026-08-19",
        total: "4300.0000",
        paid: "0",
        outstanding: "4300.0000",
        daysOverdue: 0,
      },
    ],
    creditOnAccount: "0",
    totalOutstanding: "16800.0000",
    totalOverdue: "12500.0000",
    oldestOverdueDays: 76,
    lastRemindedAt: null,
    ...overrides,
  };
}

describe("what a reminder says", () => {
  const message = () =>
    paymentReminderEmail({
      to: "accounts@sharma.example",
      supplierName: "Ravi Retail Mart",
      preview: preview(),
    });

  it("names every unpaid invoice rather than only a total", () => {
    // "You owe ₹16,800" is not something a customer can check against their
    // own records, and an unverifiable demand is one that gets ignored.
    const text = message().text;
    expect(text).toContain("INV-0001");
    expect(text).toContain("INV-0009");
    expect(text).toContain("₹12,500.00");
    expect(text).toContain("₹4,300.00");
  });

  it("says which are late and which are not yet due", () => {
    const text = message().text;
    expect(text).toContain("76 days ago");
    expect(text).toContain("not yet due");
  });

  it("separates what is past due from the whole balance", () => {
    const text = message().text;
    expect(text).toContain("Total outstanding: ₹16,800.00");
    expect(text).toContain("Of which past due: ₹12,500.00");
  });

  it("threatens nothing and invents no consequence", () => {
    // The shop's arrangement with this customer is not something this product
    // knows. Any of these words would be the product speaking beyond it.
    const text = message().text.toLowerCase();
    for (const word of [
      "interest",
      "penalty",
      "legal",
      "failing which",
      "immediately",
      "must be paid",
      "action will",
      "suspend",
    ]) {
      expect(text, `a reminder should not say "${word}"`).not.toContain(word);
    }
  });

  it("allows for the customer being right and the books being wrong", () => {
    const text = message().text;
    expect(text).toContain("does not match your records");
  });

  it("allows for the payment already being on its way", () => {
    // A reminder that crosses a payment in the post should not read as an
    // accusation when it arrives.
    expect(message().text).toContain("already on its way");
  });

  it("signs off as the shop, not as the software", () => {
    const text = message().text;
    expect(text).toContain("Ravi Retail Mart");
    expect(text).not.toContain("Retail Intelligence AI");
  });
});

describe("when nothing is overdue", () => {
  const nothingLate = preview({
    invoices: [
      {
        id: "s2",
        number: "INV-0009",
        date: "2026-07-20",
        dueDate: "2026-08-19",
        total: "4300.0000",
        paid: "0",
        outstanding: "4300.0000",
        daysOverdue: 0,
      },
    ],
    totalOutstanding: "4300.0000",
    totalOverdue: "0",
    oldestOverdueDays: 0,
  });

  it("is a statement of account rather than a reminder", () => {
    // Chasing somebody who has done nothing wrong is how a shop loses a
    // customer, so the message changes its name and its opening sentence.
    const sent = paymentReminderEmail({
      to: "accounts@sharma.example",
      supplierName: "Ravi Retail Mart",
      preview: nothingLate,
    });
    expect(sent.subject).toContain("Statement of account");
    expect(sent.subject).not.toContain("reminder");
    expect(sent.text).toContain("Here is your current account");
    expect(sent.text).not.toContain("past its due date");
  });

  it("omits the past-due line entirely rather than printing zero", () => {
    const sent = paymentReminderEmail({
      to: "accounts@sharma.example",
      supplierName: "Ravi Retail Mart",
      preview: nothingLate,
    });
    expect(sent.text).not.toContain("Of which past due");
  });
});

/**
 * A customer who has sent money without saying which invoice it was for.
 *
 * The statement has to show it. Netting it silently into a smaller total
 * leaves them holding a payment they can see in their own records and a figure
 * from the shop that does not mention it — which is exactly the argument this
 * module was written to avoid.
 */
describe("when they have paid on account", () => {
  const paidSome = preview({
    creditOnAccount: "5000.0000",
    totalOutstanding: "11800.0000",
    totalOverdue: "7500.0000",
  });

  it("says what was invoiced and what was received", () => {
    const sent = paymentReminderEmail({
      to: "accounts@sharma.example",
      supplierName: "Ravi Retail Mart",
      preview: paidSome,
    });

    // The invoices still add to 16,800; the payment is named, not absorbed.
    expect(sent.text).toContain("Invoiced: ₹16,800.00");
    expect(sent.text).toContain(
      "Less payment received, not yet applied to an invoice: ₹5,000.00",
    );
    expect(sent.text).toContain("Total outstanding: ₹11,800.00");
  });

  it("says nothing about it when there is none", () => {
    const sent = paymentReminderEmail({
      to: "accounts@sharma.example",
      supplierName: "Ravi Retail Mart",
      preview: preview(),
    });
    expect(sent.text).not.toContain("Less payment received");
    expect(sent.text).not.toContain("Invoiced:");
  });
});

describe("where it goes", () => {
  it("goes to the address it was handed and no other", () => {
    const sent = paymentReminderEmail({
      to: "accounts@sharma.example",
      supplierName: "Ravi Retail Mart",
      preview: preview(),
    });
    expect(sent.to).toBe("accounts@sharma.example");
  });
});
