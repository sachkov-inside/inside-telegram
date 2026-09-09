import { AuthorDelivery } from "./author-delivery.js";
import { CommunicationTracking } from "./communication-tracking.js";
import { Funnels } from "./funnels.js";
import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  Post,
} from "@nestjs/common";
import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from "../../config/application-config.js";
import { bearerMatches } from "../../security/credentials.js";
import { Communications } from "./communications.js";
import {
  COMMUNICATIONS_VERSION,
  CommunicationsError,
  type CommunicationsRequest,
  validRequest,
} from "./communications-contract.js";

@Controller("integrations/platform/v1/communications")
export class CommunicationsController {
  constructor(
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    @Inject(Communications) private readonly communications: Communications,
    @Inject(Funnels) private readonly funnels: Funnels,
    @Inject(AuthorDelivery) private readonly authorDelivery: AuthorDelivery,
    @Inject(CommunicationTracking)
    private readonly tracking: CommunicationTracking,
  ) {}
  @Post()
  @HttpCode(200)
  async execute(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ) {
    try {
      if (!bearerMatches(authorization, this.config.platformIntegrationSecret))
        throw new CommunicationsError("unauthorized");
      if (!validRequest(body)) throw new CommunicationsError("malformed");
      return {
        contractVersion: COMMUNICATIONS_VERSION,
        status: "ok",
        ...((body as CommunicationsRequest).operation.startsWith("templates.")
          ? (body as CommunicationsRequest).operation === "templates.list"
            ? await this.communications.list(body as CommunicationsRequest)
            : (body as CommunicationsRequest).operation === "templates.testSend"
              ? await this.authorDelivery.testSend(
                  body as CommunicationsRequest,
                )
              : {
                  template: await this.communications.execute(
                    body as CommunicationsRequest,
                  ),
                }
          : (body as CommunicationsRequest).operation.startsWith("tracking.")
            ? await this.tracking.execute(body as CommunicationsRequest)
            : await this.funnels.execute(body as CommunicationsRequest)),
      };
    } catch (error) {
      if (!(error instanceof CommunicationsError)) throw error;
      const statuses = {
        unauthorized: 401,
        forbidden: 403,
        not_found: 404,
        malformed: 400,
        unsupported_content: 422,
        revision_conflict: 409,
        operation_conflict: 409,
        authorization_unavailable: 503,
        not_implemented: 501,
      };
      throw new HttpException(
        { contractVersion: COMMUNICATIONS_VERSION, status: error.code },
        statuses[error.code],
      );
    }
  }
}
