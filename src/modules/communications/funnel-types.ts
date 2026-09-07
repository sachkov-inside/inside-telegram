import type { TemplateContent } from "./communications-contract.js";
export interface MessagePart {
  readonly partId: string;
  readonly content: TemplateContent;
}
export interface EntryResponse {
  readonly stepId: string;
  readonly parts: readonly MessagePart[];
}
export interface FunnelStep extends EntryResponse {
  readonly delaySeconds: number;
}
export interface FunnelSource {
  readonly sourceId: string;
  readonly code: string;
  readonly name: string;
}
export interface FunnelDraft {
  readonly funnelId: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly sources: readonly FunnelSource[];
  readonly steps: readonly FunnelStep[];
  readonly entryResponse: EntryResponse;
}
export interface FunnelSnapshot extends FunnelDraft {
  readonly revision: number;
  readonly publishedRevision: number | null;
  readonly lifecycle: "draft" | "published" | "paused" | "archived";
}
export interface IntroSnapshot {
  readonly introId: string;
  readonly revision: number;
  readonly parts: readonly MessagePart[];
}
export interface PartAttempt {
  readonly attemptId: string;
  readonly attemptedAt: string;
  readonly outcome: "sent" | "api_rejected" | "retryable" | "unknown";
  readonly diagnosticCode: string | null;
  readonly duplicateRiskAccepted: boolean;
}
export interface DeliveryPart {
  readonly partId: string;
  state:
    | "pending"
    | "in_flight"
    | "sent"
    | "failed"
    | "unknown"
    | "cancelled"
    | "skipped"
    | "suppressed";
  diagnosticCode: string | null;
  attempts: PartAttempt[];
}
export interface DeliverySnapshot {
  readonly deliveryId: string;
  readonly revision: number;
  readonly contactId: string;
  readonly funnelId: string | null;
  readonly broadcastId: string | null;
  readonly stepId: string | null;
  readonly publishedRevision: number;
  readonly snapshot: readonly MessagePart[];
  readonly parts: readonly DeliveryPart[];
  readonly cancelRequested: boolean;
  readonly completedAt: string | null;
}
