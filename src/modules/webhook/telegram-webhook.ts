import { timingSafeEqual } from "node:crypto";

import {
  BadRequestException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";

import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from "../../config/application-config.js";
import { RuntimeMetrics } from "../../operations/runtime-metrics.js";
import { TelegramUpdateInbox } from "../update-inbox/telegram-update-inbox.js";

@Injectable()
export class TelegramWebhook {
  constructor(
    @Inject(APPLICATION_CONFIG)
    private readonly config: ApplicationConfig,
    @Inject(TelegramUpdateInbox) private readonly inbox: TelegramUpdateInbox,
    @Inject(RuntimeMetrics) private readonly metrics: RuntimeMetrics,
  ) {}

  async accept(secret: string | undefined, payload: unknown): Promise<void> {
    if (!secretMatches(secret, this.config.webhookSecret)) {
      throw new UnauthorizedException();
    }

    const updateId = readUpdateId(payload);
    if (!updateId) {
      throw new BadRequestException("Body must be a Telegram Update");
    }

    const result = await this.inbox.accept(
      this.config.botIdentity,
      updateId,
      payload,
      new Date(),
    );
    this.metrics.increment(
      result === "accepted" ? "webhook_accepted" : "webhook_duplicate",
    );
  }
}

function secretMatches(
  candidate: string | undefined,
  expected: string,
): boolean {
  if (!candidate) {
    return false;
  }
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return (
    candidateBytes.length === expectedBytes.length &&
    timingSafeEqual(candidateBytes, expectedBytes)
  );
}

function readUpdateId(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const updateId = payload.update_id;
  if (!Number.isSafeInteger(updateId) || Number(updateId) < 0) {
    return undefined;
  }
  return String(updateId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
