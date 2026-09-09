import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
} from "@nestjs/common";

import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from "../../config/application-config.js";
import { bearerMatches } from "../../security/credentials.js";
import { CommunityProvider } from "./community-provider.js";

/**
 * The Platform → Telegram `inside.community-entitlement.v1` surface. Nothing runs
 * before authentication, validation and a durable receipt.
 */
@Controller("integrations/platform/v1/community-entitlements")
export class CommunityController {
  constructor(
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    @Inject(CommunityProvider) private readonly provider: CommunityProvider,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async apply(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ) {
    if (!bearerMatches(authorization, this.config.communityIntegrationSecret))
      throw new HttpException(
        { statusCode: HttpStatus.UNAUTHORIZED },
        HttpStatus.UNAUTHORIZED,
      );

    const handled = await this.provider.handle(body);
    if (handled.status === HttpStatus.OK && handled.body) return handled.body;
    throw new HttpException(
      handled.body ?? { statusCode: handled.status },
      handled.status,
    );
  }
}
