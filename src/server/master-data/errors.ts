/**
 * Failures a master-data operation can report back to a form.
 *
 * These are outcomes, not faults: a duplicate SKU is something the user can
 * fix, so it travels as a typed error the action layer turns into a field
 * message rather than as a stack trace.
 */
export class MasterDataError extends Error {
  constructor(
    message: string,
    readonly code: string,
    /** Form field the message belongs against, when there is one. */
    readonly field?: string,
  ) {
    super(message);
    this.name = "MasterDataError";
  }
}
