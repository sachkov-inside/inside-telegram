import { Inject, Injectable } from "@nestjs/common";

import { reportCondition } from "../../operations/failure-diagnostics.js";
import { RuntimeMetrics } from "../../operations/runtime-metrics.js";
import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from "../../config/application-config.js";
import {
  TELEGRAM_MESSAGES,
  type TelegramMessages,
} from "./telegram-messages.js";
import { StartResponseDeliveryQueue } from "./start-response-delivery-queue.js";

@Injectable()
export class StartResponseDeliveryProcessor {
  constructor(
    @Inject(StartResponseDeliveryQueue)
    private readonly queue: StartResponseDeliveryQueue,
    @Inject(TELEGRAM_MESSAGES)
    private readonly messages: TelegramMessages,
    @Inject(RuntimeMetrics) private readonly metrics: RuntimeMetrics,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
  ) {}

  async processAvailable(limit = 50, now?: Date): Promise<number> {
    return (await this.process(limit, now)).processed;
  }

  /**
   * One worker cycle. Returns whether it found work, including a reply that waits for its
   * Telegram turn: the worker keeps asking because the fairness cursor holds that turn.
   */
  async processDue(signal: AbortSignal, limit = 50): Promise<boolean> {
    const { processed, waiting } = await this.process(limit, undefined, signal);
    return processed > 0 || waiting;
  }

  private async process(
    limit: number,
    now?: Date,
    signal?: AbortSignal,
  ): Promise<{ processed: number; waiting: boolean }> {
    let processed = 0;
    for (; processed < limit && !signal?.aborted; processed += 1) {
      const attemptedAt = now ?? new Date();
      const delivery = await this.queue.claimOrWait(
        attemptedAt,
        this.config.signInEnabled === true,
      );
      if (delivery === "waiting") {
        return { processed, waiting: true };
      }
      if (!delivery) {
        break;
      }

      const result = delivery.editMessageId
        ? await this.messages.editText({
            chatId: delivery.privateChatId,
            messageId: delivery.editMessageId,
            text: delivery.messageText,
          })
        : await this.messages.sendText({
            chatId: delivery.privateChatId,
            text: delivery.messageText,
            ...(delivery.buttons ? { buttons: delivery.buttons } : {}),
            ...(delivery.signInRequestRef
              ? {
                  buttons: [
                    {
                      text: "Подтвердить вход",
                      callbackData: `signin:approve:${delivery.signInRequestRef}`,
                    },
                    {
                      text: "Отменить",
                      callbackData: `signin:deny:${delivery.signInRequestRef}`,
                    },
                  ],
                }
              : {}),
          });
      if (!(await this.queue.recordResult(delivery, result, now ?? new Date())))
        reportCondition("outbound.delivery", "lease_lost", {
          delivery_id: delivery.id,
        });
      this.metrics.increment(`delivery_${result.kind}`);
    }
    return { processed, waiting: false };
  }
}
