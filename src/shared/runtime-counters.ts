/** Operational counters that application modules report; operations renders them. */
export const RUNTIME_COUNTER_NAMES = [
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
] as const;

export type RuntimeCounter = (typeof RUNTIME_COUNTER_NAMES)[number];

export interface RuntimeCounters {
  increment(counter: RuntimeCounter, amount?: number): void;
}

export const RUNTIME_COUNTERS = Symbol("RUNTIME_COUNTERS");
