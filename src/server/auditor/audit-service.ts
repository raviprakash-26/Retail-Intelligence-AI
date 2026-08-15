import "server-only";
import { AuditFindingStatus, type AuditSeverity } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  RULES,
  RULES_VERSION,
  riskLevelFrom,
  scoreFrom,
  type RuleKey,
  type Severity,
} from "@/lib/auditor/rules";
import { runChecks, type Finding } from "@/server/auditor/checks";

/**
 * Running an audit, and keeping what it found.
 *
 * Every run is a snapshot: the checks that ran, what they found, the score
 * their severities produce, and the version of the rule set that produced it.
 * Keeping the version matters — a finding that disappears next month should be
 * explainable by "the rules changed" or "the books changed", and without the
 * version those two look identical.
 *
 * A run replaces the open findings of the previous one rather than piling up.
 * Anything a person has already acknowledged, resolved or dismissed is left
 * alone: a judgement made about a finding is worth more than the finding, and
 * re-raising it every night would train everybody to ignore the list.
 */

export type RunSummary = {
  id: string;
  periodStart: string;
  periodEnd: string;
  score: number;
  riskLevel: Severity;
  findingsCount: number;
  rulesVersion: string;
  startedAt: string;
  completedAt: string | null;
  /** Checks that could not be completed, named rather than hidden. */
  incomplete: string[];
  /**
   * True where part of the sweep did not run.
   *
   * Kept beside the score rather than left for a caller to derive, because the
   * derivation is the thing that gets forgotten. A score from an incomplete
   * sweep is a summary of what was looked at, not of what is there, and it must
   * never be read as a clean bill of health.
   */
  partial: boolean;
};

export type StoredFinding = {
  id: string;
  ruleKey: RuleKey;
  severity: Severity;
  status: AuditFindingStatus;
  title: string;
  description: string;
  recommendation: string | null;
  ordinaryExplanations: readonly string[];
  evidence: Record<string, unknown>;
  entityType: string | null;
  entityId: string | null;
  detectedAt: string;
};

export type AuditReport = {
  run: RunSummary | null;
  findings: StoredFinding[];
  /** Findings a person has already dealt with, kept out of the score. */
  settled: StoredFinding[];
};

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/** Findings a person has already formed a view on. */
const SETTLED: AuditFindingStatus[] = [
  AuditFindingStatus.ACKNOWLEDGED,
  AuditFindingStatus.RESOLVED,
  AuditFindingStatus.DISMISSED,
  AuditFindingStatus.FALSE_POSITIVE,
];

function toStored(row: {
  id: string;
  ruleKey: string;
  severity: AuditSeverity;
  status: AuditFindingStatus;
  title: string;
  description: string;
  recommendation: string | null;
  evidence: unknown;
  entityType: string | null;
  entityId: string | null;
  detectedAt: Date;
}): StoredFinding {
  const rule = RULES[row.ruleKey as RuleKey];
  return {
    id: row.id,
    ruleKey: row.ruleKey as RuleKey,
    severity: row.severity as Severity,
    status: row.status,
    title: row.title,
    description: row.description,
    recommendation: row.recommendation,
    // Read from the catalogue rather than stored, so improving the wording
    // improves every finding already on the list.
    ordinaryExplanations: rule?.ordinaryExplanations ?? [],
    evidence:
      row.evidence && typeof row.evidence === "object"
        ? (row.evidence as Record<string, unknown>)
        : {},
    entityType: row.entityType,
    entityId: row.entityId,
    detectedAt: row.detectedAt.toISOString(),
  };
}

export async function runAudit(params: {
  companyId: string;
  from: Date;
  to: Date;
  triggeredById?: string | null;
}): Promise<AuditReport> {
  const run = await prisma.auditRun.create({
    data: {
      companyId: params.companyId,
      periodStart: params.from,
      periodEnd: params.to,
      rulesVersion: RULES_VERSION,
      triggeredById: params.triggeredById ?? null,
    },
    select: { id: true, startedAt: true },
  });

  const { findings, failed } = await runChecks({
    companyId: params.companyId,
    from: params.from,
    to: params.to,
  });

  // Everything still open from before is cleared: it either fired again just
  // now or it no longer holds, and leaving a stale copy behind would double
  // every finding that persists.
  await prisma.auditFinding.deleteMany({
    where: {
      companyId: params.companyId,
      status: AuditFindingStatus.OPEN,
    },
  });

  if (findings.length > 0) {
    await prisma.auditFinding.createMany({
      data: findings.map((entry: Finding) => ({
        companyId: params.companyId,
        auditRunId: run.id,
        ruleKey: entry.ruleKey,
        severity: entry.severity as AuditSeverity,
        title: entry.title,
        description: entry.description,
        recommendation: RULES[entry.ruleKey].recommendation,
        evidence: entry.evidence as never,
        entityType: entry.entityType,
        entityId: entry.entityId,
      })),
    });
  }

  const score = scoreFrom(findings);
  const riskLevel = riskLevelFrom(findings);

  await prisma.auditRun.update({
    where: { id: run.id },
    data: {
      score,
      riskLevel: riskLevel as AuditSeverity,
      findingsCount: findings.length,
      // Stored, not just returned. This used to travel back with the response
      // and nowhere else, so reopening the page showed the same score with no
      // sign that two of the checks behind it had never run.
      incompleteChecks: failed,
      completedAt: new Date(),
    },
  });

  return getLatestAudit({ companyId: params.companyId });
}

export async function getLatestAudit(params: {
  companyId: string;
}): Promise<AuditReport> {
  const [run, open, settled] = await Promise.all([
    prisma.auditRun.findFirst({
      where: { companyId: params.companyId },
      orderBy: { startedAt: "desc" },
      select: {
        id: true,
        periodStart: true,
        periodEnd: true,
        score: true,
        riskLevel: true,
        findingsCount: true,
        rulesVersion: true,
        incompleteChecks: true,
        startedAt: true,
        completedAt: true,
      },
    }),
    prisma.auditFinding.findMany({
      where: { companyId: params.companyId, status: AuditFindingStatus.OPEN },
      orderBy: [{ severity: "desc" }, { detectedAt: "desc" }],
      select: {
        id: true,
        ruleKey: true,
        severity: true,
        status: true,
        title: true,
        description: true,
        recommendation: true,
        evidence: true,
        entityType: true,
        entityId: true,
        detectedAt: true,
      },
    }),
    prisma.auditFinding.findMany({
      where: { companyId: params.companyId, status: { in: SETTLED } },
      orderBy: { updatedAt: "desc" },
      take: 25,
      select: {
        id: true,
        ruleKey: true,
        severity: true,
        status: true,
        title: true,
        description: true,
        recommendation: true,
        evidence: true,
        entityType: true,
        entityId: true,
        detectedAt: true,
      },
    }),
  ]);

  return {
    run: run
      ? {
          id: run.id,
          periodStart: isoDay(run.periodStart),
          periodEnd: isoDay(run.periodEnd),
          score: run.score,
          riskLevel: run.riskLevel as Severity,
          findingsCount: run.findingsCount,
          rulesVersion: run.rulesVersion,
          startedAt: run.startedAt.toISOString(),
          completedAt: run.completedAt?.toISOString() ?? null,
          incomplete: run.incompleteChecks,
          partial: run.incompleteChecks.length > 0,
        }
      : null,
    findings: open.map(toStored),
    settled: settled.map(toStored),
  };
}

/**
 * Recording what somebody decided about a finding.
 *
 * The finding is not deleted and its evidence is not touched — a judgement is
 * an addition to the record, not a replacement for it. Scoped to the company so
 * an id from elsewhere updates nothing.
 */
export async function settleFinding(params: {
  companyId: string;
  findingId: string;
  status: AuditFindingStatus;
  note?: string | null;
  userId: string;
}): Promise<boolean> {
  const result = await prisma.auditFinding.updateMany({
    where: { id: params.findingId, companyId: params.companyId },
    data: {
      status: params.status,
      resolutionNote: params.note ?? null,
      resolvedById: params.userId,
      resolvedAt: params.status === AuditFindingStatus.OPEN ? null : new Date(),
    },
  });
  return result.count > 0;
}
