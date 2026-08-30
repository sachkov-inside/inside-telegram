import { Inject, Injectable } from "@nestjs/common";

import { RuntimeMetrics } from "../../operations/runtime-metrics.js";
import {
  TELEGRAM_MESSAGES,
  type TelegramMessages,
} from "./telegram-messages.js";
import { WelcomeDeliveryQueue } from "./welcome-delivery-queue.js";

@Injectable()
export class WelcomeDeliveryProcessor {
  constructor(
    @Inject(WelcomeDeliveryQueue)
    private readonly queue: WelcomeDeliveryQueue,
    @Inject(TELEGRAM_MESSAGES)
    private readonly messages: TelegramMessages,
    @Inject(RuntimeMetrics) private readonly metrics: RuntimeMetrics,
  ) {}

  async processAvailable(limit = 50, now = new Date()): Promise<number> {
    let processed = 0;
    for (; processed < limit; processed += 1) {
      const delivery = await this.queue.claimNext(now);
      if (!delivery) {
        break;
      }

      const result = await this.messages.sendText({
        chatId: delivery.privateChatId,
        text: delivery.messageText,
      });
      await this.queue.recordResult(delivery, result, now);
      this.metrics.increment(`delivery_${result.kind}`);
    }
    return processed;
  }
}
