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
      if (!bearerMatches(authorization, this.config.communicationsSecret))
        throw new CommunicationsError("unauthorized");
      if (!validRequest(body)) throw new CommunicationsError("malformed");
      return {
        contractVersion: COMMUNICATIONS_VERSION,
        status: "ok",
        ...(body.operation.startsWith("templates.")
          ? body.operation === "templates.list"
            ? await this.communications.list(body)
            : body.operation === "templates.testSend"
              ? await this.authorDelivery.testSend(body)
              : {
                  template: await this.communications.execute(body),
                }
          : body.operation.startsWith("tracking.")
            ? await this.tracking.execute(body)
            : await this.funnels.execute(body)),
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
