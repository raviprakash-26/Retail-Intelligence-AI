import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { companyScopedModels } from "@/lib/export/manifest";
import { PURGED_EXPLICITLY } from "@/server/provisioning/purge-company";

/**
 * Every company-scoped table is erased when a company is.
 *
 * `purgeCompany` deletes the company row and lets the database cascade, which
 * is right for most of the schema and silently wrong for the rest. A table
 * whose company relation is `SET NULL` is detached rather than deleted, and a
 * table with no company relation at all is never reached — in both cases the
 * rows outlive the business, matching no company, invisible to every
 * tenant-scoped query and out of reach of any ordinary cleanup.
 *
 * That is how the activity log survived erasure with `actorEmail`,
 * `ipAddress`, `userAgent` and a before-and-after payload intact.
 *
 * The integration test proves the deletion actually happens, but only for the
 * fifteen tables a bare registration populates. This one covers all of them,
 * by reading the schema rather than the data: each company-scoped model either
 * cascades from `Company`, or is named in `PURGED_EXPLICITLY` with the reason
 * it cannot.
 */

type Classified = {
  cascades: string[];
  explicit: string[];
  orphaned: string[];
};

/**
 * Whether deleting a company reaches this table by cascade.
 *
 * Transitive, because most of the schema is reached through a parent rather
 * than directly: a `SalesReturnItem` has no company relation and does not need
 * one — it cascades from its `SalesReturn`, which cascades from the company.
 * Only the side holding the foreign key can be cascaded *from*, which is what
 * `relationFromFields` identifies.
 *
 * A first version of this looked one level deep and reported seven perfectly
 * safe tables as survivors.
 */
function reachedByCascade(): Set<string> {
  const byName = new Map(
    Prisma.dmmf.datamodel.models.map((model) => [model.name, model]),
  );
  const reached = new Set<string>();

  const visit = (name: string, seen: Set<string>): boolean => {
    if (reached.has(name)) return true;
    if (name === "Company") return true;
    if (seen.has(name)) return false;
    seen.add(name);

    const model = byName.get(name);
    if (!model) return false;

    for (const field of model.fields) {
      if (field.kind !== "object") continue;
      // Only this side of the relation carries the key, so only this side is
      // deleted when the other goes.
      if (!field.relationFromFields?.length) continue;
      if (field.relationOnDelete !== "Cascade") continue;
      if (visit(field.type, seen)) {
        reached.add(name);
        return true;
      }
    }

    return false;
  };

  for (const model of Prisma.dmmf.datamodel.models) {
    visit(model.name, new Set());
  }

  return reached;
}

function classify(): Classified {
  const scoped = companyScopedModels().map((model) => model.name);
  const reached = reachedByCascade();
  const result: Classified = { cascades: [], explicit: [], orphaned: [] };

  for (const name of scoped) {
    if (reached.has(name)) result.cascades.push(name);
    else if (name in PURGED_EXPLICITLY) result.explicit.push(name);
    else result.orphaned.push(name);
  }

  return result;
}

describe("erasing a company", () => {
  it("reaches every company-scoped table", () => {
    const { orphaned } = classify();
    expect(
      orphaned,
      `these tables survive a purge — they neither cascade from Company nor are deleted explicitly: ${orphaned.join(", ")}`,
    ).toEqual([]);
  });

  it("gives a reason for every table it has to delete by hand", () => {
    for (const [model, reason] of Object.entries(PURGED_EXPLICITLY)) {
      expect(
        reason.length,
        `${model} has no reason worth the name`,
      ).toBeGreaterThan(30);
    }
  });

  it("names only tables that exist and are company-scoped", () => {
    const scoped = new Set(companyScopedModels().map((model) => model.name));
    for (const model of Object.keys(PURGED_EXPLICITLY)) {
      expect(scoped.has(model), `${model} is not a company-scoped model`).toBe(
        true,
      );
    }
  });

  it("still explains a table it deletes by hand even though it cascades", () => {
    // `Payroll` cascades perfectly well and is deleted first anyway, to get
    // out of the way of an ON DELETE RESTRICT between payslips and employees.
    // So appearing in both is legitimate, and a draft of this test that
    // forbade it was encoding a rule the code does not follow — it only has to
    // say why.
    const { cascades } = classify();
    for (const model of cascades.filter((name) => name in PURGED_EXPLICITLY)) {
      expect(PURGED_EXPLICITLY[model]!.length).toBeGreaterThan(30);
    }
  });
});
