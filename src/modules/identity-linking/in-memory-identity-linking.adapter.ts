import { Inject, Injectable } from "@nestjs/common";

import {
  IdentityLinking,
  MalformedLinkRequestError,
} from "./identity-linking.js";
import {
  readBeginLinkEnvelope,
  readConfirmationEnvelope,
  readTokenReceiptEnvelope,
  writeLinkChallenge,
  writeLinkOutcome,
  writePendingLinkOutcome,
} from "./identity-linking-http.contract.js";

export class MalformedIdentityLinkingEnvelopeError extends Error {}

@Injectable()
export class InMemoryIdentityLinkingAdapter {
  constructor(
    @Inject(IdentityLinking)
    private readonly identityLinking: IdentityLinking,
  ) {}

  async register(body: unknown) {
    const begin = readBeginLinkEnvelope(body);
    if (!begin) {
      throw new MalformedIdentityLinkingEnvelopeError();
    }
    try {
      return writeLinkChallenge(await this.identityLinking.register(begin));
    } catch (error) {
      if (error instanceof MalformedLinkRequestError) {
        throw new MalformedIdentityLinkingEnvelopeError();
      }
      throw error;
    }
  }

  async acceptStart(body: unknown) {
    const receipt = readTokenReceiptEnvelope(body);
    if (!receipt) {
      throw new MalformedIdentityLinkingEnvelopeError();
    }
    return writePendingLinkOutcome(
      await this.identityLinking.acceptStart(receipt),
    );
  }

  async confirm(linkTransactionRef: string, body: unknown) {
    const confirmation = readConfirmationEnvelope(linkTransactionRef, body);
    if (!confirmation) {
      throw new MalformedIdentityLinkingEnvelopeError();
    }
    return writeLinkOutcome(await this.identityLinking.confirm(confirmation));
  }
}
