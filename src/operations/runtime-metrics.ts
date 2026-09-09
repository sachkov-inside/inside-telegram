import { Injectable } from "@nestjs/common";

import type { CommunitySnapshot } from "../modules/community/community-provider.js";
import type { ReconciliationBatchOutcome } from "../modules/membership-evidence/membership-reconciliation.js";

type Counter =
  | "delivery_api_rejected"
  | "delivery_api_retryable"
  | "delivery_delivered"
  | "delivery_transport_unknown"
  | "reconciliation_degraded"
  | "reconciliation_failure"
  | "reconciliation_success"
  | "update_failed"
  | "update_ignored"
  | "update_processed"
  | "webhook_accepted"
  | "webhook_duplicate";

const counterNames: readonly Counter[] = [
  "webhook_accepted",
  "webhook_duplicate",
  "update_processed",
  "update_ignored",
  "update_failed",
  "delivery_delivered",
  "delivery_api_rejected",
  "delivery_api_retryable",
  "delivery_transport_unknown",
  "reconciliation_success",
  "reconciliation_failure",
  "reconciliation_degraded",
];

type Gauge =
  | "community_due"
  | "community_effect_backlog"
  | "community_oldest_due_seconds"
  | "evidence_delivery_backlog"
  | "reconciliation_due"
  | "reconciliation_oldest_due_seconds";

const gaugeNames: readonly Gauge[] = [
  "reconciliation_due",
  "reconciliation_oldest_due_seconds",
  "evidence_delivery_backlog",
  "community_due",
  "community_oldest_due_seconds",
  "community_effect_backlog",
];

@Injectable()
export class RuntimeMetrics {
  private readonly counters = new Map<Counter, number>();
  private readonly gauges = new Map<Gauge, number>();

  increment(counter: Counter, amount = 1): void {
    this.counters.set(counter, (this.counters.get(counter) ?? 0) + amount);
  }

  recordReconciliation(outcome: ReconciliationBatchOutcome): void {
    this.increment("reconciliation_success", outcome.succeeded);
    this.increment("reconciliation_failure", outcome.failed);
    this.increment("reconciliation_degraded", outcome.degraded);
    this.gauges.set("reconciliation_due", outcome.dueRemaining);
    this.gauges.set(
      "reconciliation_oldest_due_seconds",
      outcome.oldestDueAgeMs / 1000,
    );
    this.gauges.set("evidence_delivery_backlog", outcome.evidenceBacklog);
  }

  /** Community apply/reconcile lag is what makes an overdue right visible to an operator. */
  recordCommunity(snapshot: CommunitySnapshot): void {
    this.gauges.set("community_due", snapshot.dueStates);
    this.gauges.set(
      "community_oldest_due_seconds",
      snapshot.oldestDueAgeMs / 1000,
    );
    this.gauges.set("community_effect_backlog", snapshot.effectBacklog);
  }

  render(): string {
    const counters = counterNames
      .map(
        (name) =>
          `inside_telegram_${name}_total ${this.counters.get(name) ?? 0}`,
      )
      .join("\n");
    const gauges = gaugeNames
      .map((name) => `inside_telegram_${name} ${this.gauges.get(name) ?? 0}`)
      .join("\n");
    return `${counters}\n${gauges}\n`;
  }
}
