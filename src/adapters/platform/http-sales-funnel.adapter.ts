import type {
  SalesFunnelDelivery,
  SalesFunnelDeliveryResult,
} from "../../modules/sales-funnel/sales-funnel-delivery.js";
import {
  SALES_FUNNEL_EVENTS_VERSION,
  type SalesFunnelEvent,
} from "../../modules/sales-funnel/sales-funnel-events.js";
import { reportFailure } from "../../shared/failure-diagnostics.js";

const DELIVERY_TIMEOUT_MILLISECONDS = 5_000;

/** `POST /integrations/telegram/v1/sales-funnel/events` of Platform. */
export class HttpSalesFunnelAdapter implements SalesFunnelDelivery {
  constructor(
    private readonly endpoint: string,
    private readonly secret: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async deliver(event: SalesFunnelEvent): Promise<SalesFunnelDeliveryResult> {
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        body: JSON.stringify({
          contractVersion: SALES_FUNNEL_EVENTS_VERSION,
          events: [event],
        }),
        headers: {
          authorization: `Bearer ${this.secret}`,
          "content-type": "application/json",
        },
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MILLISECONDS),
      });
    } catch (error) {
      reportFailure("platform.sales-funnel-delivery", error);
      return {
        diagnosticCode: "platform_transport_unavailable",
        kind: "retryable",
      };
    }
    if (response.status === 409) return { kind: "conflict" };
    if (response.status !== 200)
      return {
        diagnosticCode: `platform_http_${response.status}`,
        kind: "retryable",
      };
    const receipt = await readReceipt(response);
    return receipt
      ? { kind: "delivered", duplicates: receipt.duplicates }
      : { diagnosticCode: "platform_receipt_invalid", kind: "retryable" };
  }
}

/** Platform's `{ contractVersion, accepted, duplicates }` for this one-event delivery. */
async function readReceipt(
  response: Response,
): Promise<{ readonly duplicates: number } | undefined> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  if (typeof body !== "object" || body === null) return undefined;
  const receipt = new Map<string, unknown>(Object.entries(body));
  const accepted = receipt.get("accepted");
  const duplicates = receipt.get("duplicates");
  return receipt.get("contractVersion") === SALES_FUNNEL_EVENTS_VERSION &&
    typeof accepted === "number" &&
    typeof duplicates === "number" &&
    Number.isInteger(accepted) &&
    Number.isInteger(duplicates) &&
    accepted >= 0 &&
    duplicates >= 0 &&
    accepted + duplicates === 1
    ? { duplicates }
    : undefined;
}
