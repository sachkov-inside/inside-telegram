import { SubscriptionActivation } from "../modules/subscription-activation/subscription-activation.js";
import { AuthorDelivery } from "../modules/communications/author-delivery.js";
import { FunnelScheduler } from "../modules/communications/funnel-scheduler.js";
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
import { purgeExpiredRecords } from "../database/retention.js";
import { CommunityProvider } from "../modules/community/community-provider.js";
import { InitialMembershipCheckProcessor } from "../modules/membership-evidence/initial-membership-check-processor.js";
import { MembershipEvidenceDeliveryProcessor } from "../modules/membership-evidence/membership-evidence-delivery-processor.js";
import { MembershipEvidenceProvider } from "../modules/membership-evidence/membership-evidence-provider.js";
import { CLOCK, type Clock } from "../modules/identity-linking/clock.js";
import { telegramTurnPending } from "../modules/outbound/telegram-transport-slots.js";
import { StartResponseDeliveryProcessor } from "../modules/outbound/start-response-delivery-processor.js";
import { TelegramUpdateInbox } from "../modules/update-inbox/telegram-update-inbox.js";
import { TelegramUpdateProcessor } from "../modules/update-inbox/telegram-update-processor.js";
import { RuntimeMetrics } from "./runtime-metrics.js";
import { WorkerLoop, type WorkerPacing } from "./worker-loop.js";

/** Every accepted webhook wakes the update cycle; idle polls only catch retries and leases. */
const UPDATES: WorkerPacing = { busyMs: 250, idleMs: 5000 };
/** Replies a user waits on; processed updates wake this cycle directly. */
const DELIVERY: WorkerPacing = { busyMs: 250, idleMs: 2000 };
const BACKGROUND: WorkerPacing = { busyMs: 500, idleMs: 5000 };
/**
 * The first probe runs at start, the next ones after doubling pauses up to once a minute: a
 * deployment waiting on `/ready` sees a fresh result soon, and a degraded provider is not
 * re-recorded every few seconds.
 */
const PROVIDER_PROBE: WorkerPacing = { busyMs: 1500, idleMs: 60_000 };
const RETENTION: WorkerPacing = { busyMs: 1000, idleMs: 3_600_000 };

/**
 * Owns the background cycles of the application process. When the application starts to
 * close, cycles stop claiming work and finish what they hold; the database pool closes only
 * in the later shutdown phase.
 */
@Injectable()
export class BackgroundWorkers
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private loops: WorkerLoop[] = [];

  constructor(
    @Inject(SubscriptionActivation)
    private readonly activation: SubscriptionActivation,
    @Inject(APPLICATION_CONFIG)
    private readonly config: ApplicationConfig,
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(TelegramUpdateInbox) private readonly inbox: TelegramUpdateInbox,
    @Inject(TelegramUpdateProcessor)
    private readonly updates: TelegramUpdateProcessor,
    @Inject(StartResponseDeliveryProcessor)
    private readonly deliveries: StartResponseDeliveryProcessor,
    @Inject(AuthorDelivery) private readonly authorDelivery: AuthorDelivery,
    @Inject(FunnelScheduler) private readonly funnels: FunnelScheduler,
    @Inject(InitialMembershipCheckProcessor)
    private readonly membershipChecks: InitialMembershipCheckProcessor,
    @Inject(MembershipEvidenceDeliveryProcessor)
    private readonly evidenceDeliveries: MembershipEvidenceDeliveryProcessor,
    @Inject(MembershipEvidenceProvider)
    private readonly membershipEvidence: MembershipEvidenceProvider,
    @Inject(CommunityProvider) private readonly community: CommunityProvider,
    @Inject(RuntimeMetrics) private readonly metrics: RuntimeMetrics,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.workersEnabled) {
      return;
    }

    await this.funnels.assertConfigured();
    const loops: WorkerLoop[] = [];
    const add = (
      name: string,
      pacing: WorkerPacing,
      cycle: (signal: AbortSignal) => Promise<boolean>,
    ): WorkerLoop => {
      const loop = new WorkerLoop(name, cycle, pacing);
      loops.push(loop);
      return loop;
    };

    if (this.config.activation?.enabled) {
      add("activation", BACKGROUND, async () => {
        const processed = await this.activation.processAvailable();
        this.metrics.recordActivation(await this.activation.snapshot());
        return processed > 0;
      });
    }

    const deliveries =
      this.config.deliveryMode === "live"
        ? add("delivery", DELIVERY, async (signal) => {
            const replies = await this.deliveries.processAvailable(
              50,
              undefined,
              signal,
            );
            const posts = await this.authorDelivery.processAvailable();
            return replies + posts > 0 || (await this.turnPending("general"));
          })
        : undefined;

    const updates = add("updates", UPDATES, async (signal) => {
      const processed = await this.updates.processAvailable(
        50,
        undefined,
        signal,
      );
      // Processing an update usually plans a reply; send it without waiting for a poll.
      if (processed > 0) deliveries?.wake();
      return processed > 0;
    });
    this.inbox.onAccepted(() => updates.wake());

    if (this.config.deliveryMode === "live" && this.config.marketingEnabled) {
      add(
        "marketing",
        BACKGROUND,
        async () =>
          (await this.funnels.processAvailable()) > 0 ||
          (await this.turnPending("general")),
      );
    }

    if (this.config.membershipMode === "live") {
      add("membership", BACKGROUND, async () => {
        const outcome = await this.membershipEvidence.reconcileDue(
          { maxDurationMs: 2000, maxItems: 25 },
          this.clock,
        );
        this.metrics.recordReconciliation(outcome);
        const checks = await this.membershipChecks.processAvailable(1);
        return outcome.processed + checks > 0;
      });
      add("membership.provider", PROVIDER_PROBE, async () => {
        await this.membershipEvidence.probeProvider();
        return false;
      });
    }

    if (this.config.communityMode === "live") {
      add("community", BACKGROUND, async () => {
        const effects = await this.community.processDueEffects();
        const states = await this.community.reconcileDueStates();
        this.metrics.recordCommunity(await this.community.snapshot());
        return effects + states > 0;
      });
    }

    if (this.config.evidenceDeliveryMode === "live") {
      add(
        "evidence",
        BACKGROUND,
        async () => (await this.evidenceDeliveries.processAvailable()) > 0,
      );
    }

    add(
      "retention",
      RETENTION,
      async () =>
        (await purgeExpiredRecords(this.database, this.clock.now())) > 0,
    );

    this.loops = loops;
    for (const loop of loops) loop.start();
  }

  /**
   * A sender refused a Telegram turn keeps its busy pace: the fairness cursor holds that turn
   * for it, so a sleeping sender would stall every other sender until it wakes.
   */
  private turnPending(purpose: "general"): Promise<boolean> {
    return telegramTurnPending(
      this.database,
      this.config.botIdentity,
      purpose,
      this.clock.now(),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.loops.map((loop) => loop.stop()));
  }
}
