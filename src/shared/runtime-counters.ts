/** Operational counters that application modules report; operations renders them. */
export type RuntimeCounter =
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

export interface RuntimeCounters {
  increment(counter: RuntimeCounter, amount?: number): void;
}

export const RUNTIME_COUNTERS = Symbol("RUNTIME_COUNTERS");
