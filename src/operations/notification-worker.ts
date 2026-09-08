import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
} from "../config/application-config.js";
import { DATABASE, type Database } from "../database/database.js";
import { NotificationProvider } from "../modules/notifications/notification-provider.js";
import { NotificationBroker } from "../adapters/amqp/notification-broker.js";
import { HttpNotificationAuthorization } from "../adapters/platform/http-notification-authorization.adapter.js";
import {
  TELEGRAM_MESSAGES,
  type TelegramMessages,
} from "../modules/outbound/telegram-messages.js";
import { CLOCK, type Clock } from "../modules/identity-linking/clock.js";
@Injectable()
export class NotificationWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(NotificationWorker.name);
  private broker?: NotificationBroker;
  private provider?: NotificationProvider;
  private timer?: NodeJS.Timeout;
  private cycles = new Map<string, Promise<void>>();
  private reconnectAt = 0;
  private stopping = false;
  private retentionAt = 0;
  constructor(
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(TELEGRAM_MESSAGES) private readonly transport: TelegramMessages,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}
  onApplicationBootstrap() {
    const n = this.config.notifications;
    if (!n || !this.config.workersEnabled) return;
    this.provider = new NotificationProvider(
      this.db,
      this.config.botIdentity,
      this.clock,
      new HttpNotificationAuthorization(n.authorizeUrl, n.authorizeSecret),
      this.transport,
      Buffer.from(n.quarantineKey, "hex"),
    );
    this.broker = new NotificationBroker(
      n.brokerUrl,
      this.provider,
      n.prefetch,
      () =>
        this.logger.error(
          "Notification broker unavailable; durable work retained",
        ),
    );
    this.timer = setInterval(() => this.tick(), 40);
    this.timer.unref();
    this.tick();
  }
  private tick() {
    if (this.stopping || !this.broker || !this.provider) return;
    const b = this.broker,
      p = this.provider;
    if (!b.connected && Date.now() >= this.reconnectAt)
      this.run("connect", async () => {
        this.reconnectAt = Date.now() + 5000;
        try {
          await b.open();
        } catch {
          await b.close();
          throw new Error("Notification connection failed");
        }
      });
    if (b.connected)
      this.run("results", () => p.publishResults((r) => b.publish(r)));
    // Durable work continues through broker outages; disabled external delivery never starts an attempt.
    if (this.config.deliveryMode === "live")
      for (const category of ["subscription", "material"] as const)
        this.run(category, () =>
          p.processCategory(category, this.config.notifications!.batchSize),
        );
    if (Date.now() >= this.retentionAt) {
      this.retentionAt = Date.now() + 60000;
      this.run("retention", () => p.expireQuarantinePayloads());
    }
  }
  private run(name: string, action: () => Promise<void>) {
    if (this.cycles.has(name)) return;
    const cycle = action()
      .catch(() => {
        this.logger.error(
          `Notification ${name} cycle failed; durable work retained`,
        );
      })
      .finally(() => {
        this.cycles.delete(name);
      });
    this.cycles.set(name, cycle);
  }
  async onModuleDestroy() {
    this.stopping = true;
    clearInterval(this.timer);
    await Promise.allSettled(this.cycles.values());
    await this.broker?.close();
  }
}
