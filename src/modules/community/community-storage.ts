import type { ColumnType } from "kysely";

import type {
  CommunityAccess,
  AdmissionRestriction,
  CommunityEffect,
  CommunityResult,
  CommunitySetCommand,
  CommunityStatus,
  ObservedMembership,
} from "./community-contract.js";

type Timestamp = ColumnType<Date, Date, Date>;
type RevisionColumn = ColumnType<
  string,
  bigint | number | string,
  bigint | number | string
>;
type TelegramIdColumn = ColumnType<string, string, string>;

/** The next external action an effect still owes, or `done` when it owes none. */
export type CommunityEffectStep =
  | "observe"
  | "unban"
  | "create_invite"
  | "approve"
  | "ban"
  | "revoke_link"
  | "done";

export type CommunityEffectState =
  "pending" | "started" | "unknown" | "completed" | "superseded" | "failed";

export type CommunityInviteState = "none" | "unknown" | "created" | "revoked";

/** Only a real external mutation becomes an attempt; observing is not one. */
export type CommunityMutation = Exclude<
  CommunityEffectStep,
  "observe" | "done"
>;

export type CommunityAttemptOutcome =
  "started" | "unknown" | "succeeded" | "not_started" | "rejected";

export type CommunityRemovalOrigin =
  "none" | "bot_expiry" | "operator_restore" | "external_unknown";

export interface RestrictionAuditState {
  readonly admissionRestriction: AdmissionRestriction;
  readonly removalOrigin: CommunityRemovalOrigin;
  readonly confirmedBanAttemptId: string | null;
  readonly status: CommunityStatus;
}

/** Immutable decision context; never copied from the later mutable projection. */
export interface RestrictionDecisionAudit {
  readonly version: 1;
  readonly target: {
    readonly botIdentity: string;
    readonly accountRef: string;
    readonly identityRef: string;
    readonly linkRef: string;
    readonly linkRevision: string;
  };
  readonly action: "hold" | "restore";
  readonly expectedRevision: number;
  readonly appliedRevision: number;
  readonly before: RestrictionAuditState;
  readonly after: RestrictionAuditState;
  readonly communityOperation: {
    readonly operationId: string;
    readonly correlationRef: string;
    readonly contractVersion: CommunitySetCommand["contractVersion"];
    readonly entitlementRevision: string;
  };
}

export interface CommunityTables {
  community_desired_states: {
    last_membership_update_id: ColumnType<
      string | null,
      string | null | undefined,
      string | null
    >;
    confirmed_ban_attempt_id: ColumnType<
      string | null,
      string | null | undefined,
      string | null
    >;
    restriction_revision: ColumnType<
      string,
      number | undefined,
      number | string
    >;
    last_membership_event_at: ColumnType<
      Date | null,
      Date | null | undefined,
      Date | null
    >;
    admission_restriction: ColumnType<
      AdmissionRestriction,
      AdmissionRestriction | undefined,
      AdmissionRestriction
    >;
    removal_origin: ColumnType<
      CommunityRemovalOrigin,
      CommunityRemovalOrigin | undefined,
      CommunityRemovalOrigin
    >;
    bot_identity: string;
    account_ref: string;
    entitlement_revision: RevisionColumn;
    latest_operation: string;
    telegram_identity_ref: string;
    link_ref: string;
    link_revision: RevisionColumn;
    access: CommunityAccess;
    valid_until: Timestamp | null;
    invite_link: string | null;
    invite_state: CommunityInviteState;
    invite_expires_at: Timestamp | null;
    invite_revision: RevisionColumn | null;
    status: CommunityStatus;
    observed_membership: ObservedMembership;
    due_at: Timestamp;
    updated_at: Timestamp;
  };
  community_operations: {
    operation_id: string;
    bot_identity: string;
    account_ref: string;
    entitlement_revision: RevisionColumn;
    payload_digest: string;
    command: CommunitySetCommand;
    result: CommunityResult;
    status: CommunityStatus;
    created_at: Timestamp;
    updated_at: Timestamp;
  };
  community_bindings: {
    bot_identity: string;
    account_ref: string;
    telegram_identity_ref: string;
    link_ref: string;
    link_revision: RevisionColumn;
    telegram_user_id: TelegramIdColumn | null;
    first_seen_at: Timestamp;
    last_seen_at: Timestamp;
  };
  community_restriction_decisions: {
    audit: ColumnType<
      RestrictionDecisionAudit | null,
      RestrictionDecisionAudit,
      never
    >;
    operation_id: string;
    fingerprint: string;
    actor_ref: string;
    reason: string;
    created_at: Timestamp;
  };
  community_effects: {
    join_invite_digest: ColumnType<
      string | null,
      string | null | undefined,
      string | null
    >;
    join_invite_expires_at: ColumnType<
      Date | null,
      Date | null | undefined,
      Date | null
    >;
    effect_ref: string;
    bot_identity: string;
    account_ref: string;
    telegram_identity_ref: string;
    operation_id: string;
    entitlement_revision: RevisionColumn;
    effect: CommunityEffect;
    step: CommunityEffectStep;
    state: CommunityEffectState;
    join_request_key: string | null;
    available_at: Timestamp;
    attempt_count: number;
    retry_count: number;
    diagnostic_code: string | null;
    created_at: Timestamp;
    updated_at: Timestamp;
  };
  community_effect_attempts: {
    restriction_revision: ColumnType<
      string,
      string | number | undefined,
      string | number
    >;
    attempt_id: string;
    effect_ref: string;
    permit_ref: string;
    action: CommunityMutation;
    started_at: Timestamp;
    outcome: CommunityAttemptOutcome;
    diagnostic_code: string | null;
  };
}
