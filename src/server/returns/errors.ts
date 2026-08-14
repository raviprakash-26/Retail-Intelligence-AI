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
