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
import { bearerMatches } from "../../security/credentials.js";
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
          requestRef: envelope("requestRef"),
          startTokenDigest: envelope("startTokenDigest"),
          browserSecretDigest: envelope("browserSecretDigest"),
          expiresAt: new Date(envelope("expiresAt")),
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
        envelope("subjectRef"),
        envelope("accountRef"),
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
        envelope("browserSecret"),
        consume,
      )),
    };
  }

  private authenticate(authorization: string | undefined): void {
    if (!bearerMatches(authorization, this.config.signInIntegrationSecret))
      throw new UnauthorizedException();
  }
}

/** Validates the whole envelope, then reads its string fields by name. */
function readEnvelope<const Field extends string>(
  body: unknown,
  fields: readonly Field[],
): (field: Field) => string {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new BadRequestException();
  const record = new Map<string, unknown>(Object.entries(body));
  const values = new Map<string, string>();
  for (const field of fields) {
    const value = record.get(field);
    if (typeof value === "string" && value.length <= 128)
      values.set(field, value);
  }
  if (
    record.get("contractVersion") !== CONTRACT_VERSION ||
    record.size !== fields.length + 1 ||
    values.size !== fields.length
  )
    throw new BadRequestException();
  return (field) => {
    const value = values.get(field);
    if (value === undefined) throw new BadRequestException();
    return value;
  };
}
