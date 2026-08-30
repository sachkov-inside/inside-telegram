import { Inject, Injectable } from "@nestjs/common";

import {
  type EvidenceOutcome,
  MembershipEvidenceProvider,
} from "./membership-evidence-provider.js";
import { InitialMembershipCheckQueue } from "./initial-membership-check-queue.js";

@Injectable()
export class InitialMembershipCheckProcessor {
  constructor(
    @Inject(InitialMembershipCheckQueue)
    private readonly queue: InitialMembershipCheckQueue,
    @Inject(MembershipEvidenceProvider)
    private readonly provider: MembershipEvidenceProvider,
  ) {}

  async processNext(now = new Date()): Promise<EvidenceOutcome | undefined> {
    const check = await this.queue.claimNext(now);
    if (!check) {
      return undefined;
    }
    try {
      const outcome = await this.provider.observe(check);
      await this.queue.complete(check, now);
      return outcome;
    } catch (error) {
      await this.queue.retry(check, now);
      throw error;
    }
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
