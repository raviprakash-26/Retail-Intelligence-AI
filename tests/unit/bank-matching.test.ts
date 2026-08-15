import { describe, expect, it } from "vitest";
import {
  extractReference,
  reconciliationDifference,
  suggestMatches,
  type BookSide,
  type StatementSide,
} from "@/lib/banking/matching";

/**
 * Suggesting matches, and the reconciliation identity.
 *
 * The matcher's job is to be right or to say nothing. Most of these cases are
 * about the second half: the pairs it must refuse to suggest, because a
 * confident wrong pairing is the one outcome that costs a business money it
 * cannot trace.
 */

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function statement(
  over: Partial<StatementSide> & Pick<StatementSide, "id">,
): StatementSide {
  return {
    date: day("2026-04-10"),
    amount: "1000",
    direction: "OUT",
    description: "Payment",
    referenceNo: null,
    ...over,
  };
}

function book(over: Partial<BookSide> & Pick<BookSide, "id">): BookSide {
  return {
    date: day("2026-04-10"),
    amount: "1000",
    direction: "OUT",
    narration: null,
    referenceNo: null,
    ...over,
  };
}

describe("what it matches", () => {
  it("pairs the same amount on the same day", () => {
    const matches = suggestMatches(
      [statement({ id: "s1" })],
      [book({ id: "b1" })],
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      statementId: "s1",
      bookId: "b1",
      confidence: "likely",
    });
    expect(matches[0]?.reason).toMatch(/same date/i);
  });

  it("prefers a reference match over a closer date", () => {
    // The cheque number is the strongest evidence available, and it is the
    // reason a fortnight-old cheque can be matched with confidence while two
    // same-day payments cannot.
    const matches = suggestMatches(
      [statement({ id: "s1", referenceNo: "CHQ 234567" })],
      [
        book({ id: "same-day" }),
        book({
          id: "by-reference",
          date: day("2026-04-24"),
          referenceNo: "234567",
        }),
      ],
    );

    expect(matches[0]?.bookId).toBe("by-reference");
    expect(matches[0]?.confidence).toBe("exact");
    expect(matches[0]?.reason).toMatch(/234567/);
  });

  it("reads a reference out of a narration somebody typed", () => {
    const matches = suggestMatches(
      [statement({ id: "s1", referenceNo: "234567", date: day("2026-04-20") })],
      [book({ id: "b1", narration: "Cheque 234567 to Sharma Traders" })],
    );
    expect(matches[0]?.confidence).toBe("exact");
  });

  it("matches a cheque number written with leading zeros", () => {
    const matches = suggestMatches(
      [
        statement({
          id: "s1",
          referenceNo: "000234567",
          date: day("2026-04-25"),
        }),
      ],
      [book({ id: "b1", referenceNo: "234567" })],
    );
    expect(matches[0]?.confidence).toBe("exact");
  });

  it("calls a match a week out possible rather than likely", () => {
    const matches = suggestMatches(
      [statement({ id: "s1", date: day("2026-04-17") })],
      [book({ id: "b1" })],
    );
    expect(matches[0]?.confidence).toBe("possible");
    expect(matches[0]?.reason).toMatch(/check before accepting/i);
  });
});

describe("what it refuses to match", () => {
  it("never pairs amounts that merely look close", () => {
    // The entire output of a reconciliation is the difference between two sets
    // of figures. A tolerance would consume the signal it exists to produce.
    const matches = suggestMatches(
      [statement({ id: "s1", amount: "1000" })],
      [book({ id: "b1", amount: "1000.50" })],
    );
    expect(matches).toEqual([]);
  });

  it("never pairs money out with money in", () => {
    const matches = suggestMatches(
      [statement({ id: "s1", direction: "OUT" })],
      [book({ id: "b1", direction: "IN" })],
    );
    expect(matches).toEqual([]);
  });

  it("leaves an entry alone when it is too old to be the same thing", () => {
    const matches = suggestMatches(
      [statement({ id: "s1", date: day("2026-06-01") })],
      [book({ id: "b1", date: day("2026-04-10") })],
    );
    expect(matches).toEqual([]);
  });

  it("does not chase combinations that add up", () => {
    // Three ₹500 entries summing to a ₹1,500 deposit is a real thing, and
    // searching for subsets that total correctly produces coincidences at a
    // rate no person could audit. Left unmatched, for somebody to look at.
    const matches = suggestMatches(
      [statement({ id: "s1", amount: "1500", direction: "IN" })],
      [
        book({ id: "b1", amount: "500", direction: "IN" }),
        book({ id: "b2", amount: "500", direction: "IN" }),
        book({ id: "b3", amount: "500", direction: "IN" }),
      ],
    );
    expect(matches).toEqual([]);
  });

  it("ignores a reference too short to mean anything", () => {
    // A two-digit "12" would match a large fraction of any statement.
    const matches = suggestMatches(
      [statement({ id: "s1", referenceNo: "12", date: day("2026-05-05") })],
      [book({ id: "b1", referenceNo: "12" })],
    );
    expect(matches).toEqual([]);
  });
});

describe("when several could pair", () => {
  it("uses each side once", () => {
    const matches = suggestMatches(
      [statement({ id: "s1" }), statement({ id: "s2" })],
      [book({ id: "b1" })],
    );
    expect(matches).toHaveLength(1);
    expect(matches.map((match) => match.bookId)).toEqual(["b1"]);
  });

  it("pairs a repeated payment in date order rather than arbitrarily", () => {
    // A shop paying the same rent twice in a fortnight is the case that breaks
    // a naive first-found matcher: both statement lines fit both entries, and
    // the pairing has to be stable or two runs disagree.
    const matches = suggestMatches(
      [
        statement({ id: "later", date: day("2026-04-15") }),
        statement({ id: "earlier", date: day("2026-04-01") }),
      ],
      [
        book({ id: "book-earlier", date: day("2026-04-01") }),
        book({ id: "book-later", date: day("2026-04-15") }),
      ],
    );

    expect(matches).toHaveLength(2);
    const pairs = Object.fromEntries(
      matches.map((match) => [match.statementId, match.bookId]),
    );
    expect(pairs).toEqual({
      earlier: "book-earlier",
      later: "book-later",
    });
  });

  it("gives the same answer whatever order the rows arrive in", () => {
    // Without a total ordering the result depends on however the database
    // happened to sort, and two runs of the same reconciliation disagree.
    const statements = [
      statement({ id: "s1", date: day("2026-04-02") }),
      statement({ id: "s2", date: day("2026-04-03") }),
    ];
    const books = [
      book({ id: "b1", date: day("2026-04-02") }),
      book({ id: "b2", date: day("2026-04-03") }),
    ];

    const forward = suggestMatches(statements, books);
    const reversed = suggestMatches(
      [...statements].reverse(),
      [...books].reverse(),
    );

    const normalise = (matches: ReturnType<typeof suggestMatches>) =>
      matches
        .map((match) => `${match.statementId}:${match.bookId}`)
        .sort()
        .join(",");
    expect(normalise(reversed)).toBe(normalise(forward));
  });
});

describe("pulling a reference out of free text", () => {
  it("finds a cheque number", () => {
    expect(extractReference("Cheque 234567 issued to Sharma")).toBe("234567");
  });

  it("ignores a short number that is probably not one", () => {
    expect(extractReference("Paid 2 cartons")).toBeNull();
  });

  it("copes with nothing at all", () => {
    expect(extractReference(null)).toBeNull();
    expect(extractReference("")).toBeNull();
  });
});

describe("the reconciliation identity", () => {
  it("reports nothing unexplained when the timing differences account for it", () => {
    // Books show ₹50,000. The statement shows ₹58,000 because a ₹10,000 cheque
    // has not been presented and a ₹2,000 deposit has not been credited.
    const difference = reconciliationDifference({
      perBooks: "50000",
      perStatement: "58000",
      unmatchedBook: [
        { amount: "10000", direction: "OUT" },
        { amount: "2000", direction: "IN" },
      ],
      unmatchedStatement: [],
    });

    expect(difference.unpresentedNet.toString()).toBe("-8000");
    expect(difference.unexplained.toString()).toBe("0");
  });

  it("accounts for a bank charge the books have never seen", () => {
    // The classic one-sided item: the bank took ₹236 and nobody recorded it.
    const difference = reconciliationDifference({
      perBooks: "50000",
      perStatement: "49764",
      unmatchedBook: [],
      unmatchedStatement: [{ amount: "236", direction: "OUT" }],
    });

    expect(difference.unrecordedNet.toString()).toBe("-236");
    expect(difference.unexplained.toString()).toBe("0");
  });

  it("reports a real gap as a figure rather than absorbing it", () => {
    // Nothing explains this ₹500. Silently rounding it away would defeat the
    // only purpose the exercise has.
    const difference = reconciliationDifference({
      perBooks: "50000",
      perStatement: "49500",
      unmatchedBook: [],
      unmatchedStatement: [],
    });

    expect(difference.unexplained.toString()).toBe("500");
  });

  it("works in paise, not just round rupees", () => {
    const difference = reconciliationDifference({
      perBooks: "1234.56",
      perStatement: "1000.06",
      unmatchedBook: [{ amount: "234.50", direction: "IN" }],
      unmatchedStatement: [],
    });
    expect(difference.unexplained.toString()).toBe("0");
  });
});
