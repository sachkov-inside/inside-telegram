import type {
  MembershipEvidence,
  MembershipEvidenceSource,
} from "./membership-evidence.js";

export interface PlatformEvidenceDeliveryRequest {
  readonly evidence: MembershipEvidence;
  readonly idempotencyKey: string;
  readonly source: MembershipEvidenceSource;
}

export type PlatformEvidenceDeliveryResult =
  | { readonly kind: "delivered" }
  | { readonly diagnosticCode: string; readonly kind: "rejected" }
  | { readonly diagnosticCode: string; readonly kind: "retryable" };

export interface PlatformEvidenceDelivery {
  deliver(
    request: PlatformEvidenceDeliveryRequest,
  ): Promise<PlatformEvidenceDeliveryResult>;
}

export const PLATFORM_EVIDENCE_DELIVERY = Symbol("PLATFORM_EVIDENCE_DELIVERY");

export class DisabledPlatformEvidenceDelivery implements PlatformEvidenceDelivery {
  async deliver(): Promise<PlatformEvidenceDeliveryResult> {
    return {
      diagnosticCode: "platform_evidence_delivery_disabled",
      kind: "retryable",
    };
  }
}
