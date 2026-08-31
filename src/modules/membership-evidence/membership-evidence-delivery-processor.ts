import { Inject, Injectable } from "@nestjs/common";

import { MembershipEvidenceOutbox } from "./membership-evidence-outbox.js";
import {
  PLATFORM_EVIDENCE_DELIVERY,
  type PlatformEvidenceDelivery,
  type PlatformEvidenceDeliveryResult,
} from "./platform-evidence-delivery.js";

@Injectable()
export class MembershipEvidenceDeliveryProcessor {
  constructor(
    @Inject(MembershipEvidenceOutbox)
    private readonly outbox: MembershipEvidenceOutbox,
    @Inject(PLATFORM_EVIDENCE_DELIVERY)
    private readonly platform: PlatformEvidenceDelivery,
  ) {}

  async processNext(
    now = new Date(),
  ): Promise<PlatformEvidenceDeliveryResult["kind"] | undefined> {
    const delivery = await this.outbox.claimNext(now);
    if (!delivery) {
      return undefined;
    }
    if (!(await this.outbox.isClaimActive(delivery))) {
      return "rejected";
    }
    let result: PlatformEvidenceDeliveryResult;
    try {
      result = await this.platform.deliver({
        evidence: delivery.evidence,
        idempotencyKey: delivery.idempotencyKey,
      });
    } catch {
      result = {
        diagnosticCode: "platform_transport_unavailable",
        kind: "retryable",
      };
    }
    await this.outbox.recordResult(delivery, result, now);
    return result.kind;
  }

  async processAvailable(limit = 50, now = new Date()): Promise<number> {
    let processed = 0;
    for (; processed < limit; processed += 1) {
      const outcome = await this.processNext(now);
      if (!outcome) {
        break;
      }
    }
    return processed;
  }
}
