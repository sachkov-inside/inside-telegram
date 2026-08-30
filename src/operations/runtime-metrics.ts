import { Injectable } from "@nestjs/common";

type Counter =
  | "delivery_api_rejected"
  | "delivery_api_retryable"
  | "delivery_delivered"
  | "delivery_transport_unknown"
  | "update_failed"
  | "update_ignored"
  | "update_processed"
  | "webhook_accepted"
  | "webhook_duplicate";

const counterNames: readonly Counter[] = [
  "webhook_accepted",
  "webhook_duplicate",
  "update_processed",
  "update_ignored",
  "update_failed",
  "delivery_delivered",
  "delivery_api_rejected",
  "delivery_api_retryable",
  "delivery_transport_unknown",
];

@Injectable()
export class RuntimeMetrics {
  private readonly counters = new Map<Counter, number>();

  increment(counter: Counter): void {
    this.counters.set(counter, (this.counters.get(counter) ?? 0) + 1);
  }

  render(): string {
    return `${counterNames
      .map(
        (name) =>
          `inside_telegram_${name}_total ${this.counters.get(name) ?? 0}`,
      )
      .join("\n")}\n`;
  }
}
