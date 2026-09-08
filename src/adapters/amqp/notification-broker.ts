import {
  connect,
  type ChannelModel,
  type Channel,
  type ConfirmChannel,
  type ConsumeMessage,
} from "amqplib";
import type { NotificationInbox } from "../../modules/notifications/notification-ports.js";
import type {
  Category,
  NotificationResult,
} from "../../modules/notifications/notification-contract.js";

// Runtime never declares topology: its principal has no configure permissions.
export class NotificationBroker {
  private connection?: ChannelModel;
  private publisher?: ConfirmChannel;
  private consumers: Channel[] = [];
  private pending = new Set<Promise<void>>();
  private healthy = false;
  private closing = false;
  private publishTail: Promise<void> = Promise.resolve();
  private returned = false;
  constructor(
    private readonly url: string,
    private readonly inbox: NotificationInbox,
    private readonly prefetch: number,
    private readonly alert: () => void,
  ) {}
  get connected() {
    return this.healthy;
  }
  async open(): Promise<void> {
    await this.close();
    this.closing = false;
    const endpoint = new URL(this.url);
    endpoint.searchParams.set("heartbeat", "10");
    const connection = await connect(endpoint.toString(), { timeout: 5000 });
    this.connection = connection;
    connection.on("error", () => this.fail());
    connection.on("close", () => this.fail());
    this.publisher = await connection.createConfirmChannel();
    this.publisher.on("error", () => this.fail());
    this.publisher.on("close", () => this.fail());
    this.publisher.on("return", () => {
      this.returned = true;
    });
    this.healthy = true;
    for (const category of ["subscription", "material"] as const) {
      const channel = await connection.createChannel();
      this.consumers.push(channel);
      channel.on("error", () => this.fail());
      channel.on("close", () => this.fail());
      await channel.prefetch(this.prefetch);
      await channel.consume(
        `telegram.notifications.${category}.v1`,
        (message) => {
          if (!message) {
            this.fail();
            return;
          }
          const task = this.accept(channel, message, category);
          this.pending.add(task);
          void task.finally(() => this.pending.delete(task));
        },
        { noAck: false },
      );
    }
  }
  private async accept(
    channel: Channel,
    message: ConsumeMessage,
    category: Category,
  ): Promise<void> {
    try {
      await this.inbox.receive(
        message.content,
        {
          exchange: message.fields.exchange,
          routingKey: message.fields.routingKey,
          contentType: message.properties.contentType,
          type: message.properties.type,
          messageId: message.properties.messageId,
          persistent: message.properties.deliveryMode === 2,
        },
        category,
      );
      channel.ack(message);
    } catch {
      // Storage/quarantine failure: close consumer, retain unacked work, alert; reconnect has backoff.
      this.fail();
      await channel.close().catch(() => undefined);
    }
  }
  publish(result: NotificationResult): Promise<void> {
    const task = this.publishTail.then(() => this.publishOne(result));
    this.publishTail = task.catch(() => undefined);
    return task;
  }
  private async publishOne(result: NotificationResult): Promise<void> {
    const channel = this.publisher;
    if (!channel || !this.healthy)
      throw new Error("Notification broker unavailable");
    this.returned = false;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.fail();
        reject(new Error("Notification confirm timeout"));
      }, 5000);
      channel.publish(
        "inside.results.telegram.v1",
        "delivery.result",
        Buffer.from(JSON.stringify(result)),
        {
          mandatory: true,
          persistent: true,
          contentType: "application/json",
          type: result.contractVersion,
          messageId: result.messageId,
        },
        (error: unknown) => {
          clearTimeout(timeout);
          if (error || this.returned)
            reject(new Error("Notification result not confirmed/routed"));
          else resolve();
        },
      );
    });
  }
  private fail() {
    this.healthy = false;
    if (!this.closing) this.alert();
  }
  async close(): Promise<void> {
    this.closing = true;
    this.healthy = false;
    const connection = this.connection;
    this.connection = undefined;
    this.publisher = undefined;
    for (const c of this.consumers) await c.close().catch(() => undefined);
    this.consumers = [];
    await Promise.allSettled([...this.pending, this.publishTail]);
    if (connection) await connection.close().catch(() => undefined);
  }
}
