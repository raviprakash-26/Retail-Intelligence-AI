import "server-only";
import type { DbClient } from "@/lib/db";

/**
 * The branch a document this member posts will land on.
 *
 * A member restricted to one branch posts to that branch, whatever the request
 * says; an unrestricted member posts to the primary branch. Every posting path
 * — sales, purchases, expenses, stock adjustments — already worked this out the
 * same way, in the same four lines, inside its own transaction.
 *
 * Four copies of a rule nobody disagreed about is not by itself a problem. The
 * problem is that a *reader* has to answer the same question, and the readers
 * were not looking at this rule at all.
 *
 * Stock is held per branch. `recordOutward` reads the position at the branch
 * the sale is posting to and refuses to go below nil there, so what the invoice
 * form calls "in stock" and what the sale will allow are one question. The form
 * was adding every branch's balance together: a cashier at the second shop saw
 * the first shop's stock in the badge beside the product, saw no shortage
 * warning against a quantity the branch could not cover, and was refused on
 * submit with a different number in the message. The stock-adjustment form had
 * already been given the rule — "the same branch the adjustment will post
 * against, so the figure shown beside the count box is the one it will be
 * compared with" — and the sales form had not.
 *
 * So the rule lives here, and a reader that needs to agree with a writer can
 * reach the writer's own answer rather than guessing at it.
 *
 * Takes a client so a service can pass its transaction and resolve the branch
 * under the same lock as everything else it is about to write.
 */
export async function postingBranchId(
  client: DbClient,
  params: {
    companyId: string;
    /** The member's own branch, where they are restricted to one. */
    memberBranchId?: string | null;
  },
): Promise<string | null> {
  if (params.memberBranchId) return params.memberBranchId;

  const primary = await client.branch.findFirst({
    where: { companyId: params.companyId, isPrimary: true },
    select: { id: true },
  });

  // Null is a position of its own rather than "any branch", which is why it is
  // returned rather than treated as absent: `readPosition` looks the balance up
  // on the branch exactly, and a company with no primary branch keeps its stock
  // on the null one.
  return primary?.id ?? null;
}

/**
 * The state a document posted at this branch is supplied from, or to.
 *
 * The branch form says, under the state field, that "a branch in another state
 * changes how its supplies are taxed". Nothing read the column. `stateCode` was
 * written by `createBranch` and `updateBranch` and by nothing else, and every
 * posting path asked the head office instead — so a Bengaluru company selling
 * from its Chennai branch to a Chennai customer compared state 29 against state
 * 33, called a local sale inter-state, and charged IGST where CGST and SGST were
 * due. The wrong tax head, on the invoice and in the wrong table of GSTR-1,
 * which is the same failure `import-service` already warns about one level down.
 *
 * This is the rule the module was written for, applied to the other question a
 * branch answers. `postingBranchId` decides where a document lands; this decides
 * what that means for tax, and both the service that posts and the form that
 * previews it now reach the same answer instead of guessing separately.
 *
 * Falls back to the company's own state, which is the ordinary case: the field
 * is optional, and a branch across town is in the same state as the shop that
 * owns it.
 *
 * **What this does not do** is give a branch its own GSTIN. A place of business
 * in another state requires its own registration, and the product holds one
 * GSTIN per company — so an invoice from that branch still prints the head
 * office's number. That is a real limit, and it is a separate one: taxing a
 * local supply locally is right whether or not the registration behind it has
 * been modelled yet, and taxing it as inter-state was wrong either way.
 */
export async function postingStateCode(
  client: DbClient,
  params: {
    companyId: string;
    /** The branch the document lands on, as `postingBranchId` decided. */
    branchId: string | null;
    /** The head office's state, for a branch that names none. */
    companyStateCode: string | null;
  },
): Promise<string | null> {
  if (!params.branchId) return params.companyStateCode;

  const branch = await client.branch.findFirst({
    where: { id: params.branchId, companyId: params.companyId },
    select: { stateCode: true },
  });

  return branch?.stateCode ?? params.companyStateCode;
}
