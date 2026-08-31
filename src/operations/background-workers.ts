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
import { InitialMembershipCheckProcessor } from "../modules/membership-evidence/initial-membership-check-processor.js";
import { MembershipEvidenceDeliveryProcessor } from "../modules/membership-evidence/membership-evidence-delivery-processor.js";
import { MembershipEvidenceProvider } from "../modules/membership-evidence/membership-evidence-provider.js";
import { systemClock } from "../modules/identity-linking/clock.js";
import { StartResponseDeliveryProcessor } from "../modules/outbound/start-response-delivery-processor.js";
import { TelegramUpdateProcessor } from "../modules/update-inbox/telegram-update-processor.js";
import { RuntimeMetrics } from "./runtime-metrics.js";

@Injectable()
export class BackgroundWorkers
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(BackgroundWorkers.name);
  private deliveryCycleRunning = false;
  private deliveryTimer?: NodeJS.Timeout;
  private evidenceCycleRunning = false;
  private evidenceTimer?: NodeJS.Timeout;
  private membershipCycleRunning = false;
  private membershipCycle?: Promise<void>;
  private membershipTimer?: NodeJS.Timeout;
  private stopping = false;
  private updateCycleRunning = false;
  private updateTimer?: NodeJS.Timeout;

  constructor(
    @Inject(APPLICATION_CONFIG)
    private readonly config: ApplicationConfig,
    @Inject(TelegramUpdateProcessor)
    private readonly updates: TelegramUpdateProcessor,
    @Inject(StartResponseDeliveryProcessor)
    private readonly deliveries: StartResponseDeliveryProcessor,
    @Inject(InitialMembershipCheckProcessor)
    private readonly membershipChecks: InitialMembershipCheckProcessor,
    @Inject(MembershipEvidenceDeliveryProcessor)
    private readonly evidenceDeliveries: MembershipEvidenceDeliveryProcessor,
    @Inject(MembershipEvidenceProvider)
    private readonly membershipEvidence: MembershipEvidenceProvider,
    @Inject(RuntimeMetrics) private readonly metrics: RuntimeMetrics,
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

    if (this.config.membershipMode === "live") {
      this.membershipTimer = setInterval(
        () => void this.runMembershipCycle(),
        500,
      );
      this.membershipTimer.unref();
      void this.runMembershipCycle();
    }

    if (this.config.evidenceDeliveryMode === "live") {
      this.evidenceTimer = setInterval(() => void this.runEvidenceCycle(), 500);
      this.evidenceTimer.unref();
      void this.runEvidenceCycle();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    clearInterval(this.updateTimer);
    clearInterval(this.deliveryTimer);
    clearInterval(this.evidenceTimer);
    clearInterval(this.membershipTimer);
    await this.membershipCycle;
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

  private runMembershipCycle(): Promise<void> {
    if (this.membershipCycleRunning || this.stopping) {
      return Promise.resolve();
    }
    this.membershipCycleRunning = true;
    const cycle = this.executeMembershipCycle();
    this.membershipCycle = cycle;
    return cycle;
  }

  private async executeMembershipCycle(): Promise<void> {
    try {
      await this.membershipChecks.processAvailable();
      const outcome = await this.membershipEvidence.reconcileDue(
        { maxDurationMs: 2000, maxItems: 25 },
        systemClock,
      );
      this.metrics.recordReconciliation(outcome);
    } catch {
      this.logger.error("Membership worker cycle failed");
    } finally {
      this.membershipCycleRunning = false;
      this.membershipCycle = undefined;
    }
  }

  private async runEvidenceCycle(): Promise<void> {
    if (this.evidenceCycleRunning) {
      return;
    }
    this.evidenceCycleRunning = true;
    try {
      await this.evidenceDeliveries.processAvailable();
    } catch {
      this.logger.error("Membership Evidence delivery worker cycle failed");
    } finally {
      this.evidenceCycleRunning = false;
    }
  }
}
