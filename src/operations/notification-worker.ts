import {
  Inject,
  Injectable,
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
import { CLOCK, type Clock } from "../shared/clock.js";
import { telegramTurnPending } from "../modules/outbound/telegram-transport-slots.js";
import { reportCondition } from "../shared/failure-diagnostics.js";
import { WorkerLoop, type WorkerPacing } from "./worker-loop.js";

const RECONNECT_MILLISECONDS = 5000;
const RETENTION_MILLISECONDS = 60_000;
/** Broker deliveries and dispatches wake these cycles; idle polls only catch retries. */
const NOTIFICATIONS: WorkerPacing = { busyMs: 40, idleMs: 5000 };

@Injectable()
export class NotificationWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private broker?: NotificationBroker;
  private loops: WorkerLoop[] = [];

  constructor(
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(TELEGRAM_MESSAGES) private readonly transport: TelegramMessages,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onApplicationBootstrap() {
    const notifications = this.config.notifications;
    if (!notifications || !this.config.workersEnabled) return;
    const provider = new NotificationProvider(
      this.db,
      this.config.botIdentity,
      this.clock,
      new HttpNotificationAuthorization(
        notifications.authorizeUrl,
        notifications.authorizeSecret,
      ),
      this.transport,
      Buffer.from(notifications.quarantineKey, "hex"),
    );
    const results = new WorkerLoop(
      "notification.results",
      async () =>
        broker.connected &&
        (await provider.publishResults((result) => broker.publish(result))) > 0,
      NOTIFICATIONS,
    );
    // Durable work continues through broker outages; disabled external delivery never starts an attempt.
    const categories =
      this.config.deliveryMode === "live"
        ? (["subscription", "material"] as const).map(
            (category) =>
              new WorkerLoop(
                `notification.${category}`,
                async () => {
                  const dispatched = await provider.processCategory(
                    category,
                    notifications.batchSize,
                  );
                  if (dispatched > 0) results.wake();
                  // A category refused a Telegram turn keeps asking: the fairness cursor holds it.
                  return (
                    dispatched > 0 ||
                    (await telegramTurnPending(
                      this.db,
                      this.config.botIdentity,
                      category,
                      this.clock.now(),
                    ))
                  );
                },
                NOTIFICATIONS,
              ),
          )
        : [];
    const broker = new NotificationBroker(
      notifications.brokerUrl,
      {
        receive: async (bytes, envelope, category) => {
          const result = await provider.receive(bytes, envelope, category);
          for (const loop of categories) loop.wake();
          results.wake();
          return result;
        },
      },
      notifications.prefetch,
      // Durable work is retained while the broker is unavailable.
      () => reportCondition("notification.broker", "broker_unavailable"),
    );
    this.broker = broker;
    let retentionAt = 0;
    const maintenance = new WorkerLoop(
      "notification.maintenance",
      async () => {
        if (!broker.connected) {
          try {
            await broker.open();
            results.wake();
          } catch (error) {
            await broker.close();
            throw error;
          }
        }
        if (this.clock.now().getTime() >= retentionAt) {
          retentionAt = this.clock.now().getTime() + RETENTION_MILLISECONDS;
          await provider.expireQuarantinePayloads();
        }
        return false;
      },
      { busyMs: RECONNECT_MILLISECONDS, idleMs: RECONNECT_MILLISECONDS },
    );
    this.loops = [maintenance, results, ...categories];
    for (const loop of this.loops) loop.start();
  }

  async onModuleDestroy() {
    await Promise.all(this.loops.map((loop) => loop.stop()));
    await this.broker?.close();
  }
}
