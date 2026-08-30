import { Inject, Injectable } from "@nestjs/common";

import { RuntimeMetrics } from "../../operations/runtime-metrics.js";
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
