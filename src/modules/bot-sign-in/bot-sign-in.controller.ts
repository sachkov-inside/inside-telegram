import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Header,
  HttpCode,
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
import { BotSignIn, MalformedSignInRequestError } from "./bot-sign-in.js";

import { SignInAccountLink } from "./sign-in-account-link.js";

const CONTRACT_VERSION = "inside.bot-sign-in.v1";

@Controller("integrations/identity/v1/sign-in")
export class BotSignInController {
  constructor(
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    @Inject(BotSignIn) private readonly signIn: BotSignIn,
    @Inject(SignInAccountLink) private readonly accountLink: SignInAccountLink,
  ) {}

  @Post()
  @Header("Cache-Control", "no-store")
  @HttpCode(200)
  async register(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ) {
    this.authenticate(authorization);
    if (!this.config.signInEnabled)
      return { contractVersion: CONTRACT_VERSION, status: "disabled" };
    const envelope = readEnvelope(body, [
      "requestRef",
      "startTokenDigest",
      "browserSecretDigest",
      "expiresAt",
    ]);
    try {
      return {
        contractVersion: CONTRACT_VERSION,
        ...(await this.signIn.register({
          requestRef: envelope.requestRef!,
          startTokenDigest: envelope.startTokenDigest!,
          browserSecretDigest: envelope.browserSecretDigest!,
          expiresAt: new Date(envelope.expiresAt!),
        })),
      };
    } catch (error) {
      if (error instanceof MalformedSignInRequestError)
        throw new BadRequestException();
      throw error;
    }
  }

  @Post(":requestRef/status")
  @Header("Cache-Control", "no-store")
  @HttpCode(200)
  async status(
    @Headers("authorization") authorization: string | undefined,
    @Param("requestRef") requestRef: string,
    @Body() body: unknown,
  ) {
    return this.inspect(authorization, requestRef, body, false);
  }

  @Post(":requestRef/consume")
  @Header("Cache-Control", "no-store")
  @HttpCode(200)
  async consume(
    @Headers("authorization") authorization: string | undefined,
    @Param("requestRef") requestRef: string,
    @Body() body: unknown,
  ) {
    return this.inspect(authorization, requestRef, body, true);
  }

  @Post(":requestRef/account-link")
  @Header("Cache-Control", "no-store")
  @HttpCode(200)
  async bindAccount(
    @Headers("authorization") authorization: string | undefined,
    @Param("requestRef") requestRef: string,
    @Body() body: unknown,
  ) {
    this.authenticate(authorization);
    const envelope = readEnvelope(body, ["subjectRef", "accountRef"]);
    return {
      contractVersion: CONTRACT_VERSION,
      ...(await this.accountLink.bind(
        requestRef,
        envelope.subjectRef!,
        envelope.accountRef!,
      )),
    };
  }

  private async inspect(
    authorization: string | undefined,
    requestRef: string,
    body: unknown,
    consume: boolean,
  ) {
    this.authenticate(authorization);
    const envelope = readEnvelope(body, ["browserSecret"]);
    return {
      contractVersion: CONTRACT_VERSION,
      ...(await this.signIn.inspect(
        requestRef,
        envelope.browserSecret!,
        consume,
      )),
    };
  }

  private authenticate(authorization: string | undefined): void {
    if (
      !this.config.signInIntegrationSecret ||
      !authorization?.startsWith("Bearer ") ||
      !credentialsMatch(
        authorization.slice(7),
        this.config.signInIntegrationSecret,
      )
    )
      throw new UnauthorizedException();
  }
}

function readEnvelope(
  body: unknown,
  fields: readonly string[],
): Record<string, string> {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new BadRequestException();
  const record = body as Record<string, unknown>;
  if (
    record.contractVersion !== CONTRACT_VERSION ||
    Object.keys(record).length !== fields.length + 1 ||
    fields.some(
      (field) =>
        typeof record[field] !== "string" ||
        (record[field] as string).length > 128,
    )
  )
    throw new BadRequestException();
  return record as Record<string, string>;
}
