import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import type { Database } from "../../database/database.js";
import {
  claim,
  expireLeases,
  retryDelay,
  settle,
  type DurableQueue,
  type Lease,
} from "../../database/durable-queue.js";
import type { Clock } from "../../shared/clock.js";
import type {
  EvidenceOutcome,
  LinkMembershipCheck,
} from "./membership-evidence-provider.js";
import { reportFailure } from "../../shared/failure-diagnostics.js";

const reconciliations: DurableQueue<"membership_reconciliations"> = {
  table: "membership_reconciliations",
  key: ["telegram_identity_ref"],
  order: ["due_at", "telegram_identity_ref"],
  ready: ["pending"],
  leased: "processing",
  due: "due_at",
  attempts: "attempt_count",
  leasedAt: "locked_at",
  leaseMs: 60_000,
  retry: { initialMs: 15_000, maxMs: 60_000 },
};

export interface WorkBudget {
  readonly maxDurationMs: number;
  readonly maxItems: number;
}

export interface ReconciliationBatchOutcome {
  readonly degraded: number;
  readonly dueRemaining: number;
  readonly evidenceBacklog: number;
  readonly failed: number;
  readonly oldestDueAgeMs: number;
  readonly processed: number;
  readonly recoveredLeases: number;
  readonly stoppedReason: "empty" | "item_limit" | "time_limit";
  readonly succeeded: number;
}

export interface ReconciliationMembershipCheck extends LinkMembershipCheck {
  readonly leaseExpiresAt: Date;
  readonly leaseToken: string;
}

export class ReconciliationLeaseLostError extends Error {
  constructor() {
    super("Membership reconciliation lease is no longer current");
    this.name = "ReconciliationLeaseLostError";
  }
}

interface ClaimedReconciliation extends ReconciliationMembershipCheck {
  readonly attemptNumber: number;
  readonly lease: Lease<"membership_reconciliations">;
  readonly recoveredLeases: number;
}

export async function reconcileMembershipDue(
  database: Database,
  budget: WorkBudget,
  clock: Clock,
  cadenceMilliseconds: number,
  observe: (
    check: ReconciliationMembershipCheck,
    timeoutMilliseconds: number,
  ) => Promise<EvidenceOutcome>,
): Promise<ReconciliationBatchOutcome> {
  assertWorkBudget(budget);
  const startedAt = clock.now();
  await ensureSchedules(database, startedAt, cadenceMilliseconds);

  let degraded = 0;
  let failed = 0;
  let processed = 0;
  let recoveredLeases = 0;
  let stoppedReason: ReconciliationBatchOutcome["stoppedReason"] = "empty";
  let succeeded = 0;

  while (processed < budget.maxItems) {
    const now = clock.now();
    if (now.getTime() - startedAt.getTime() >= budget.maxDurationMs) {
      stoppedReason = "time_limit";
      break;
    }
    const claimed = await claimNext(database, now);
    if (!claimed) {
      stoppedReason = "empty";
      break;
    }
    processed += 1;
    recoveredLeases += claimed.recoveredLeases;
    try {
      const remainingDuration = Math.max(
        1,
        budget.maxDurationMs - (clock.now().getTime() - startedAt.getTime()),
      );
      const outcome = await observe(claimed, remainingDuration);
      const completedAt = clock.now();
      if (outcome.evidence.decision === "unavailable") {
        failed += 1;
        if (outcome.providerState !== "ready") {
          degraded += 1;
        }
        await retry(database, claimed, completedAt, "provider_unavailable");
      } else {
        succeeded += 1;
        await complete(database, claimed, completedAt, cadenceMilliseconds);
      }
    } catch (error) {
      if (error instanceof ReconciliationLeaseLostError) {
        failed += 1;
        continue;
      }
      reportFailure("membership.reconciliation", error);
      failed += 1;
      await retry(database, claimed, clock.now(), "reconciliation_failed");
    }
  }

  const measuredAt = clock.now();
  const snapshot = await operationalSnapshot(database, measuredAt);
  if (
    stoppedReason !== "time_limit" &&
    processed >= budget.maxItems &&
    snapshot.dueRemaining > 0
  ) {
    stoppedReason = "item_limit";
  }
  return {
    degraded,
    ...snapshot,
    failed,
    processed,
    recoveredLeases,
    stoppedReason,
    succeeded,
  };
}

async function ensureSchedules(
  database: Database,
  now: Date,
  cadenceMilliseconds: number,
): Promise<void> {
  await sql`
    insert into membership_reconciliations (
      telegram_identity_ref,
      state,
      due_at,
      attempt_count,
      locked_at,
      lease_token,
      last_completed_at,
      diagnostic_code,
      updated_at
    )
    select
      platform_links.telegram_identity_ref,
      'pending',
      platform_links.linked_at + ${cadenceMilliseconds} * interval '1 millisecond',
      0,
      null,
      null,
      null,
      null,
      ${now}
    from platform_links
    on conflict (telegram_identity_ref) do nothing
  `.execute(database);
}

async function claimNext(
  database: Database,
  now: Date,
): Promise<ClaimedReconciliation | undefined> {
  return database.transaction().execute(async (transaction) => {
    const recovered = await expireLeases(transaction, reconciliations, now, {
      diagnostic_code: "worker_lease_expired",
      lease_token: null,
      locked_at: null,
      state: "pending",
      updated_at: now,
    });
    const leaseToken = randomUUID();
    const due = await claim(transaction, reconciliations, now, {
      select: ["due_at", "telegram_identity_ref"],
      prepare: async () => ({
        diagnostic_code: null,
        lease_token: leaseToken,
        updated_at: now,
      }),
    });
    if (!due) {
      return undefined;
    }
    return {
      attemptNumber: due.attempt,
      checkRef: `reconciliation:${due.row.telegram_identity_ref}:${due.row.due_at.getTime()}`,
      lease: due,
      leaseExpiresAt: new Date(now.getTime() + reconciliations.leaseMs),
      leaseToken,
      recoveredLeases: recovered.length,
      telegramIdentityRef: due.row.telegram_identity_ref,
    };
  });
}

async function complete(
  database: Database,
  claimed: ClaimedReconciliation,
  completedAt: Date,
  cadenceMilliseconds: number,
): Promise<void> {
  await settle(database, reconciliations, claimed.lease, {
    attempt_count: 0,
    diagnostic_code: null,
    due_at: new Date(completedAt.getTime() + cadenceMilliseconds),
    last_completed_at: completedAt,
    lease_token: null,
    locked_at: null,
    state: "pending",
    updated_at: completedAt,
  });
}

async function retry(
  database: Database,
  claimed: ClaimedReconciliation,
  failedAt: Date,
  diagnosticCode: string,
): Promise<void> {
  await settle(database, reconciliations, claimed.lease, {
    diagnostic_code: diagnosticCode,
    due_at: new Date(
      failedAt.getTime() + retryDelay(reconciliations, claimed.attemptNumber),
    ),
    lease_token: null,
    locked_at: null,
    state: "pending",
    updated_at: failedAt,
  });
}

async function operationalSnapshot(
  database: Database,
  now: Date,
): Promise<{
  readonly dueRemaining: number;
  readonly evidenceBacklog: number;
  readonly oldestDueAgeMs: number;
}> {
  const due = await sql<{ due_count: string; oldest_due_at: Date | null }>`
    select
      count(*)::text as due_count,
      min(due_at) as oldest_due_at
    from membership_reconciliations
    where state = 'pending' and due_at <= ${now}
  `.execute(database);
  const backlog = await sql<{ backlog_count: string }>`
    select count(*)::text as backlog_count
    from membership_evidence_outbox
    where state in ('pending', 'retry_scheduled', 'delivering')
  `.execute(database);
  const oldestDueAt = due.rows[0]?.oldest_due_at;
  return {
    dueRemaining: Number(due.rows[0]?.due_count ?? 0),
    evidenceBacklog: Number(backlog.rows[0]?.backlog_count ?? 0),
    oldestDueAgeMs: oldestDueAt
      ? Math.max(0, now.getTime() - oldestDueAt.getTime())
      : 0,
  };
}

function assertWorkBudget(budget: WorkBudget): void {
  if (
    !Number.isInteger(budget.maxItems) ||
    budget.maxItems < 1 ||
    budget.maxItems > 100 ||
    !Number.isInteger(budget.maxDurationMs) ||
    budget.maxDurationMs < 1 ||
    budget.maxDurationMs > 60_000
  ) {
    throw new Error("Membership reconciliation work budget is invalid");
  }
}
