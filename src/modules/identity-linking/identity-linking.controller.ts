import { timingSafeEqual } from "node:crypto";

import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  UnauthorizedException,
} from "@nestjs/common";

import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from "../../config/application-config.js";
import {
  IdentityLinking,
  MalformedLinkRequestError,
} from "./identity-linking.js";
import {
  IDENTITY_LINKING_CONTRACT_VERSION,
  readBeginLinkEnvelope,
  readConfirmationEnvelope,
  writeLinkChallenge,
  writeLinkOutcome,
} from "./identity-linking-http.contract.js";

@Controller("integrations/platform/v1/identity-links")
export class IdentityLinkingController {
  constructor(
    @Inject(APPLICATION_CONFIG)
    private readonly config: ApplicationConfig,
    @Inject(IdentityLinking)
    private readonly identityLinking: IdentityLinking,
  ) {}

  @Post()
  async register(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ) {
    this.authenticate(authorization);
    const begin = readBeginLinkEnvelope(body);
    if (!begin) {
      throw malformedRequest();
    }
    try {
      return writeLinkChallenge(await this.identityLinking.register(begin));
    } catch (error) {
      if (error instanceof MalformedLinkRequestError) {
        throw malformedRequest();
      }
      throw error;
    }
  }

  @Post(":linkTransactionRef/confirm")
  @HttpCode(HttpStatus.OK)
  async confirm(
    @Headers("authorization") authorization: string | undefined,
    @Param("linkTransactionRef") linkTransactionRef: string,
    @Body() body: unknown,
  ) {
    this.authenticate(authorization);
    const confirmation = readConfirmationEnvelope(linkTransactionRef, body);
    if (!confirmation) {
      throw malformedRequest();
    }
    return writeLinkOutcome(await this.identityLinking.confirm(confirmation));
  }

  private authenticate(authorization: string | undefined): void {
    const prefix = "Bearer ";
    if (!authorization?.startsWith(prefix)) {
      throw new UnauthorizedException();
    }
    const candidate = Buffer.from(authorization.slice(prefix.length));
    const expected = Buffer.from(this.config.platformIntegrationSecret);
    if (
      candidate.length !== expected.length ||
      !timingSafeEqual(candidate, expected)
    ) {
      throw new UnauthorizedException();
    }
  }
}

function malformedRequest(): BadRequestException {
  return new BadRequestException({
    contractVersion: IDENTITY_LINKING_CONTRACT_VERSION,
    status: "malformed",
  });
}
