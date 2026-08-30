import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";

import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from "../config/application-config.js";
import { WelcomeDeliveryProcessor } from "../modules/outbound/welcome-delivery-processor.js";
import { TelegramUpdateProcessor } from "../modules/update-inbox/telegram-update-processor.js";

@Injectable()
export class BackgroundWorkers
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(BackgroundWorkers.name);
  private deliveryCycleRunning = false;
  private deliveryTimer?: NodeJS.Timeout;
  private updateCycleRunning = false;
  private updateTimer?: NodeJS.Timeout;

  constructor(
    @Inject(APPLICATION_CONFIG)
    private readonly config: ApplicationConfig,
    @Inject(TelegramUpdateProcessor)
    private readonly updates: TelegramUpdateProcessor,
    @Inject(WelcomeDeliveryProcessor)
    private readonly deliveries: WelcomeDeliveryProcessor,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.workersEnabled) {
      return;
    }

    this.updateTimer = setInterval(() => void this.runUpdateCycle(), 250);
    this.updateTimer.unref();
    void this.runUpdateCycle();

    if (this.config.deliveryMode === "live") {
      this.deliveryTimer = setInterval(() => void this.runDeliveryCycle(), 500);
      this.deliveryTimer.unref();
      void this.runDeliveryCycle();
    }
  }

  onApplicationShutdown(): void {
    clearInterval(this.updateTimer);
    clearInterval(this.deliveryTimer);
  }

  private async runUpdateCycle(): Promise<void> {
    if (this.updateCycleRunning) {
      return;
    }
    this.updateCycleRunning = true;
    try {
      await this.updates.processAvailable();
    } catch {
      this.logger.error("Telegram update worker cycle failed");
    } finally {
      this.updateCycleRunning = false;
    }
  }

  private async runDeliveryCycle(): Promise<void> {
    if (this.deliveryCycleRunning) {
      return;
    }
    this.deliveryCycleRunning = true;
    try {
      await this.deliveries.processAvailable();
    } catch {
      this.logger.error("Telegram delivery worker cycle failed");
    } finally {
      this.deliveryCycleRunning = false;
    }
  }
}
