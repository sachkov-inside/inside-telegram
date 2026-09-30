import type { SalesFunnelEvent } from "./sales-funnel-events.js";

/**
 * What Platform answered. `delivered` is `200`, `conflict` is `409` for an event id Platform
 * already holds with other content; every other answer or transport failure is `retryable`.
 */
export type SalesFunnelDeliveryResult =
  | { readonly kind: "delivered"; readonly duplicates: number }
  | { readonly kind: "conflict" }
  | { readonly kind: "retryable"; readonly diagnosticCode: string };

/**
 * Sends one event to Platform's `inside.sales-funnel-events.v1` ingress. One event per request
 * keeps a `409` from rejecting unrelated events of the same batch.
 */
export interface SalesFunnelDelivery {
  deliver(event: SalesFunnelEvent): Promise<SalesFunnelDeliveryResult>;
}

export const SALES_FUNNEL_DELIVERY = Symbol("SALES_FUNNEL_DELIVERY");
