import { describe, expect, it } from "vitest";
import {
  isPostedFromStatementLine,
  STATEMENT_POSTING_SOURCE,
  STATEMENT_POSTING_REVERSAL_SOURCE,
} from "@/server/banking/record-from-statement";

/**
 * "Was this entry posted from this statement line?"
 *
 * The question `unmatchTransaction` has to answer before it decides whether
 * breaking a link is the whole of an undo or only half of one. A match
 * somebody made joins two records that already existed and breaking it changes
 * nothing else; a recorded line is joined to an entry that exists *because* of
 * it, and breaking that link alone strands the entry in the ledger.
 *
 * It gets its own cases because the database cannot currently produce the one
 * that separates the two halves of the predicate. Every entry stamped with a
 * statement line is linked to that line and no other — `matchTransaction`
 * refuses an entry that is already matched, and `recordFromStatement` matches
 * what it posts in the same step. So asking only the source type would give
 * the same answers today, and would stop doing so the moment anything else
 * posts against a statement line.
 *
 * That is worth holding rather than trusting, because answering a narrow
 * question with a broad one is the exact shape of the defect this predicate
 * closes: the link was being read as "has this line been recorded", which it
 * is only until somebody unmatches it.
 */

const LINE = "0198f0a1-2b3c-7d4e-8f90-1a2b3c4d5e6f";
const OTHER_LINE = "0198f0a1-2b3c-7d4e-8f90-aaaaaaaaaaaa";

describe("an entry posted from a statement line", () => {
  it("is recognised by its own line", () => {
    expect(
      isPostedFromStatementLine(
        { sourceType: STATEMENT_POSTING_SOURCE, sourceId: LINE },
        LINE,
      ),
    ).toBe(true);
  });

  it("is not recognised by a different line", () => {
    // The half the database cannot reach today. Without it the predicate reads
    // "some statement line produced this", and unmatching one line would take
    // back a posting made from another.
    expect(
      isPostedFromStatementLine(
        { sourceType: STATEMENT_POSTING_SOURCE, sourceId: OTHER_LINE },
        LINE,
      ),
    ).toBe(false);
  });

  it("does not recognise an entry from a document", () => {
    // A sale's entry, hand-matched to a statement line. Unmatching a match
    // somebody made must post nothing at all.
    expect(
      isPostedFromStatementLine({ sourceType: "SALE", sourceId: LINE }, LINE),
    ).toBe(false);
  });

  it("does not recognise the reversal of a statement posting", () => {
    // A reversal is stamped with the entry it cancels, not with a line.
    expect(
      isPostedFromStatementLine(
        { sourceType: STATEMENT_POSTING_REVERSAL_SOURCE, sourceId: LINE },
        LINE,
      ),
    ).toBe(false);
  });

  it("does not recognise an entry with no source at all", () => {
    expect(
      isPostedFromStatementLine({ sourceType: null, sourceId: null }, LINE),
    ).toBe(false);
  });
});
