import "server-only";
import type { DbClient } from "@/lib/db";
import { allocateDocumentNumber } from "@/server/sequences/document-sequence";
import type { DocumentSeriesKey } from "@/lib/documents/sequences";
import { MasterDataError } from "./errors";

/**
 * Allocates the next free code for a master record.
 *
 * Master codes may skip a number; invoice numbers may not. A gap in an invoice
 * series is the first thing a tax officer asks about, so `allocateDocumentNumber`
 * deliberately releases an unused number on rollback. A gap in a customer code
 * means nothing to anyone — so when a code turns out to be taken, this walks
 * forward instead of failing.
 *
 * It has to walk because a code can exist without the counter knowing: imported
 * records, and data created before the series was in use, both leave codes
 * behind that the sequence has never issued.
 */
const MAX_ATTEMPTS = 25;

export async function allocateMasterCode(
  tx: DbClient,
  params: {
    companyId: string;
    /** Document-sequence key: CUSTOMER, SUPPLIER, EMPLOYEE. */
    key: DocumentSeriesKey;
    /** True when the candidate is already used by another record. */
    isTaken: (code: string) => Promise<boolean>;
  },
): Promise<string> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const code = await allocateDocumentNumber(tx, {
      companyId: params.companyId,
      key: params.key,
    });
    if (!(await params.isTaken(code))) return code;
  }

  throw new MasterDataError(
    "Could not allocate a code for this record. Check the numbering series in settings.",
    "CODE_EXHAUSTED",
  );
}
