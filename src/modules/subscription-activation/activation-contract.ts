import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import schema from "./contracts/schema.json" with { type: "json" };

export const ACTIVATION_VERSION = "inside.subscription-activation.v1";
export interface ActivationBinding {
  readonly accountRef: string;
  readonly identityRef: string;
  readonly linkRef: string;
  readonly linkRevision: number;
}
export interface ActivationBegin {
  readonly contractVersion: typeof ACTIVATION_VERSION;
  readonly attemptId: string;
  readonly code: string;
  readonly identityRef: string;
}
export interface ActivationEvidence extends ActivationBinding {
  readonly contractVersion: typeof ACTIVATION_VERSION;
  readonly audience: "inside.platform.subscription-activation";
  readonly attemptId: string;
  readonly evidenceRef: string;
  readonly sourceRef: string;
  readonly ruleId: string;
  readonly ruleRevision: number;
  readonly checkedAt: string;
  readonly validUntil: string;
  readonly decision:
    "member" | "not_member" | "unavailable" | "registry_lookup";
}
export type ActivationState =
  | "needs_account"
  | "checking"
  | "pending_review"
  | "active"
  | "already_active"
  | "unavailable"
  | "rejected";
export type ActivationError =
  | "invalid_input"
  | "not_found"
  | "policy_paused"
  | "revision_conflict"
  | "operation_conflict"
  | "identity_conflict"
  | "source_not_confirmed"
  | "forbidden"
  | "unavailable";
export type ActivationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: ActivationError } };
export interface EnrollmentView {
  readonly id: string;
  readonly tier: {
    readonly name: string;
    readonly benefits: readonly string[];
  };
  readonly origin: "course" | "tribute" | "manual" | "platform_payment";
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly state:
    | "scheduled"
    | "active"
    | "expired"
    | "revoked"
    | "pending_verification"
    | "suspended_source";
  readonly renewal: "not_applicable" | "billing_agreement";
  readonly benefitTerms?: readonly {
    readonly capability: string;
    readonly startsAt: string;
    readonly endsAt: string | null;
    readonly revoked: boolean;
  }[];
}
export interface ActivationResponse {
  readonly contractVersion: typeof ACTIVATION_VERSION;
  readonly attemptId: string;
  readonly state: ActivationState;
  readonly enrollment: EnrollmentView | null;
  readonly rule?: {
    readonly id: string;
    readonly revision: number;
    readonly sourceRef: string;
    readonly verificationMode?: "course_membership" | "tribute_registry";
  };
}
export interface OwnAccess {
  readonly contractVersion: typeof ACTIVATION_VERSION;
  readonly enrollments: readonly EnrollmentView[];
  readonly grounds: readonly {
    readonly source: string;
    readonly capabilities: readonly string[];
    readonly startsAt: string;
    readonly validUntil: string | null;
    readonly active: boolean;
  }[];
  readonly admission: {
    readonly state: "checking" | "no_access" | "moderation_blocked" | "ready";
    readonly admissionRestriction:
      "none" | "moderation" | "external_unknown" | null;
  };
}
const ajv = new Ajv({ strict: false });
addFormats.default(ajv);
ajv.addSchema(schema);
/** Compiles one schema definition; `Shape` is the TypeScript type that definition describes. */
export const activationValidator = <Shape = unknown>(definition: string) =>
  ajv.compile<Shape>({ $ref: `${schema.$id}#/definitions/${definition}` });
export const validActivationResponse =
  activationValidator<ActivationResult<ActivationResponse>>(
    "activationResponse",
  );
export const validOwnAccessResponse =
  activationValidator<ActivationResult<OwnAccess>>("ownAccessResponse");
export const validActivationEvidence = activationValidator("evidence");

export type BindingResponse =
  | {
      readonly ok: true;
      readonly value: {
        readonly contractVersion: typeof ACTIVATION_VERSION;
      } & (
        | { readonly state: "linked"; readonly binding: ActivationBinding }
        | { readonly state: "unlinked" }
      );
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "invalid_input" | "identity_conflict" | "unavailable";
      };
    };
export const validBindingResponse =
  activationValidator<BindingResponse>("bindingResponse");
