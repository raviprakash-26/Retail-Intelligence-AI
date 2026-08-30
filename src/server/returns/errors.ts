/**
 * Why a return was refused.
 *
 * Every one of these is a rule about the books rather than a validation of the
 * form: the invoice does not exist, it was voided, the date runs backwards, or
 * more is coming back than ever went out. The code lets an action attach the
 * message to the right place without matching on prose.
 */
export type ReturnErrorCode =
  | "NOT_FOUND"
  | "NOT_POSTED"
  | "DATE_BEFORE_INVOICE"
  | "LINE_NOT_ON_INVOICE"
  | "OVER_RETURN"
  | "DUPLICATE_LINE"
  | "NO_PARTY_TO_SETTLE"
  | "NOTHING_RETURNABLE";

export class ReturnError extends Error {
  constructor(
    message: string,
    readonly code: ReturnErrorCode,
  ) {
    super(message);
    this.name = "ReturnError";
  }
}

/**
 * Refuses a return that names the same source line more than once.
 *
 * The over-return guard reads how much of a line has already come back and
 * compares each incoming line against it, but the figure it reads is fixed
 * before the loop starts and never grows as the loop runs. So two lines
 * against the same invoice line are each measured against the whole
 * outstanding quantity: three and three of five passes twice.
 *
 * Nothing has actually over-returned, and it is worth being exact about why.
 * A return item carries the *invoice's* line number rather than its own
 * position, deliberately, so a later return can tell which line it is drawing
 * down — and the table is unique on it. The second item collides and the
 * transaction rolls back. The books have been protected by a constraint that
 * exists for a different reason, and what the person filing the return sees is
 * an unhandled database error rather than a sentence about their return.
 *
 * Refused rather than added together because there is nowhere to put the
 * second item, and because merging two lines into one is rewriting the request
 * instead of answering it. `validateAllocations` reached the same conclusion
 * for a document named twice in one receipt; this is the same rule on the
 * other side of the ledger, and it is worded the same way.
 */
export function assertNoRepeatedLines(
  lines: readonly { sourceLineId: string }[],
  noun: string,
): void {
  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.sourceLineId)) {
      throw new ReturnError(
        `The same ${noun} line appears twice in this return. Put the whole quantity on one line.`,
        "DUPLICATE_LINE",
      );
    }
    seen.add(line.sourceLineId);
  }
}
