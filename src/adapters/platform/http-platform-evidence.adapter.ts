import type {
  PlatformEvidenceDelivery,
  PlatformEvidenceDeliveryRequest,
  PlatformEvidenceDeliveryResult,
} from "../../modules/membership-evidence/platform-evidence-delivery.js";

const DELIVERY_TIMEOUT_MILLISECONDS = 5_000;

export class HttpPlatformEvidenceAdapter implements PlatformEvidenceDelivery {
  constructor(
    private readonly endpoint: string,
    private readonly secret: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async deliver(
    request: PlatformEvidenceDeliveryRequest,
  ): Promise<PlatformEvidenceDeliveryResult> {
    try {
      const response = await this.fetcher(this.endpoint, {
        body: JSON.stringify(request.evidence),
        headers: {
          authorization: `Bearer ${this.secret}`,
          "content-type": "application/json",
          "idempotency-key": request.idempotencyKey,
          "x-inside-membership-evidence-source": request.source,
        },
        method: "POST",
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MILLISECONDS),
      });
      if (response.ok) {
        return { kind: "delivered" };
      }
      if (
        response.status === 408 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500
      ) {
        return {
          diagnosticCode: `platform_http_${response.status}`,
          kind: "retryable",
        };
      }
      return {
        diagnosticCode: `platform_http_${response.status}`,
        kind: "rejected",
      };
    } catch {
      return {
        diagnosticCode: "platform_transport_unavailable",
        kind: "retryable",
      };
    }
  }
}
