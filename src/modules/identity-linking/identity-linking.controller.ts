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
import { credentialsMatch } from "../../security/credentials.js";
import { IDENTITY_LINKING_CONTRACT_VERSION } from "./identity-linking-http.contract.js";
import {
  InMemoryIdentityLinkingAdapter,
  MalformedIdentityLinkingEnvelopeError,
} from "./in-memory-identity-linking.adapter.js";

@Controller("integrations/platform/v1/identity-links")
export class IdentityLinkingController {
  constructor(
    @Inject(APPLICATION_CONFIG)
    private readonly config: ApplicationConfig,
    @Inject(InMemoryIdentityLinkingAdapter)
    private readonly identityLinking: InMemoryIdentityLinkingAdapter,
  ) {}

  @Post()
  async register(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ) {
    this.authenticate(authorization);
    return this.useContract(() => this.identityLinking.register(body));
  }

  @Post(":linkTransactionRef/confirm")
  @HttpCode(HttpStatus.OK)
  async confirm(
    @Headers("authorization") authorization: string | undefined,
    @Param("linkTransactionRef") linkTransactionRef: string,
    @Body() body: unknown,
  ) {
    this.authenticate(authorization);
    return this.useContract(() =>
      this.identityLinking.confirm(linkTransactionRef, body),
    );
  }

  private authenticate(authorization: string | undefined): void {
    const prefix = "Bearer ";
    if (!authorization?.startsWith(prefix)) {
      throw new UnauthorizedException();
    }
    if (
      !credentialsMatch(
        authorization.slice(prefix.length),
        this.config.platformIntegrationSecret,
      )
    ) {
      throw new UnauthorizedException();
    }
  }

  private async useContract<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof MalformedIdentityLinkingEnvelopeError) {
        throw malformedRequest();
      }
      throw error;
    }
  }
}

function malformedRequest(): BadRequestException {
  return new BadRequestException({
    contractVersion: IDENTITY_LINKING_CONTRACT_VERSION,
    status: "malformed",
  });
}
