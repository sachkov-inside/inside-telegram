import { Ajv } from "ajv";
import addFormats from "ajv-formats";

import { digest } from "../../security/payload-digest.js";
import v2Schema from "./contracts/schema-v2.json" with { type: "json" };
import schema from "./contracts/schema.json" with { type: "json" };

export const COMMUNITY_CONTRACT_VERSION = "inside.community-entitlement.v1";
export const COMMUNITY_V2 = "inside.community-entitlement.v2";
export type CommunityVersion =
  typeof COMMUNITY_CONTRACT_VERSION | typeof COMMUNITY_V2;
export type AdmissionRestriction = "none" | "moderation" | "external_unknown";
export const DISPATCH_CONTRACT_VERSION = "inside.billing-dispatch.v1";

export type CommunityAccess =
  | { readonly kind: "denied" }
  | { readonly kind: "finite"; readonly validUntil: string }
  | { readonly kind: "lifetime" };

export interface CommunityBinding {
  readonly accountRef: string;
  readonly telegramIdentityRef: string;
  readonly linkRef: string;
  readonly linkRevision: number;
}

export interface CommunitySetCommand {
  readonly contractVersion: CommunityVersion;
  readonly operation: "entitlement.set";
  readonly operationId: string;
  readonly binding: CommunityBinding;
  readonly entitlementRevision: number;
  readonly access: CommunityAccess;
  readonly issuedAt: string;
  readonly correlationRef: string;
}

export interface CommunityStatusQuery {
  readonly contractVersion: CommunityVersion;
  readonly operation: "entitlement.status";
  readonly operationId: string;
}

export type CommunityStatus =
  | "accepted"
  | "waiting_for_join"
  | "applied"
  | "superseded"
  | "failed"
  | "unknown"
  | "expired";

export type ObservedMembership = "member" | "not_member" | "unknown";

export interface CommunityResult {
  readonly admissionRestriction?: AdmissionRestriction;
  readonly contractVersion: CommunityVersion;
  readonly operation: "entitlement.result";
  readonly operationId: string;
  readonly binding: CommunityBinding;
  readonly entitlementRevision: number;
  readonly access: CommunityAccess;
  readonly status: CommunityStatus;
  readonly observedMembership: ObservedMembership;
  readonly updatedAt: string;
}

export type CommunityErrorCode =
  | "unauthorized"
  | "unsupported_contract"
  | "malformed"
  | "not_found"
  | "operation_conflict"
  | "revision_conflict"
  | "binding_conflict"
  | "unavailable";

export interface CommunityError {
  readonly contractVersion: CommunityVersion;
  readonly operation: "entitlement.error";
  readonly operationId: string;
  readonly error: CommunityErrorCode;
}

export type CommunityResponse = CommunityResult | CommunityError;

export type CommunityEffect =
  | "community.ensure_admission"
  | "community.approve_join"
  | "community.ensure_absence";

export interface DispatchAuthorizationRequest {
  readonly contractVersion: typeof DISPATCH_CONTRACT_VERSION;
  readonly operation: "dispatch.authorize";
  readonly operationId: string;
  readonly dispatchId: string;
  readonly dispatchContractVersion: CommunityVersion;
  readonly attemptId: string;
  readonly effectRef: string;
  readonly effect: CommunityEffect;
  readonly payloadDigest: string;
}

export type DispatchDenialReason =
  | "superseded"
  | "binding_conflict"
  | "expired"
  | "not_found"
  | "payload_conflict"
  | "effect_conflict";

export type DispatchDecision =
  | {
      readonly status: "allowed";
      readonly permitRef: string;
      readonly validUntil: string;
    }
  | { readonly status: "denied"; readonly reason: DispatchDenialReason }
  | { readonly status: "unavailable" };

export interface DispatchAuthorizationResult {
  readonly contractVersion: typeof DISPATCH_CONTRACT_VERSION;
  readonly operation: "dispatch.result";
  readonly operationId: string;
  readonly dispatchId: string;
  readonly attemptId: string;
  readonly decision: DispatchDecision;
}

export interface DispatchAuthorizationError {
  readonly contractVersion: typeof DISPATCH_CONTRACT_VERSION;
  readonly operation: "dispatch.error";
  readonly operationId: string;
  readonly error: CommunityErrorCode;
}

export type DispatchAuthorizationResponse =
  DispatchAuthorizationResult | DispatchAuthorizationError;

const ajv = new Ajv({ strict: false });
addFormats.default(ajv);
ajv.addSchema(schema);
ajv.addSchema(v2Schema);
/** Compiles one schema definition; `Shape` is the TypeScript type that definition describes. */
const v2Definition = <Shape = unknown>(name: string) =>
  ajv.compile<Shape>({ $ref: `${v2Schema.$id}#/definitions/${name}` });
const validV2Set = v2Definition<CommunitySetCommand>("communitySet");
const validV2Status = v2Definition("communityStatus");
const validV2Result = v2Definition("communityResult");

const definition = <Shape = unknown>(name: string) =>
  ajv.compile<Shape>({ $ref: `${schema.$id}#/definitions/${name}` });

const validSet = definition<CommunitySetCommand>("communitySet");
const validStatusQuery = definition("communityStatus");
const validResult = definition("communityResult");
export const validDispatchResponse = definition<DispatchAuthorizationResponse>(
  "authorizationResponse",
);

/** The wire body of one authenticated `inside.community-entitlement.v1` request. */
export type ParsedCommunityRequest =
  | {
      readonly kind: "set";
      readonly command: CommunitySetCommand;
      readonly payloadDigest: string;
    }
  | { readonly kind: "status"; readonly operationId: string }
  | {
      readonly kind: "rejected";
      readonly error: CommunityErrorCode;
      readonly operationId?: string;
    };

const UUID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Normalizes UUID spelling on the boundary before any storage or fingerprint,
 * then fingerprints the exact schema-valid command the sender signed.
 */
export function parseCommunityRequest(
  body: unknown,
  version: CommunityVersion = COMMUNITY_CONTRACT_VERSION,
): ParsedCommunityRequest {
  const record = isRecord(body) ? body : undefined;
  const operationId =
    typeof record?.operationId === "string" && UUID.test(record.operationId)
      ? record.operationId.toLowerCase()
      : undefined;
  const rejected = (error: CommunityErrorCode): ParsedCommunityRequest =>
    operationId
      ? { kind: "rejected", error, operationId }
      : { kind: "rejected", error };
  if (!record) return rejected("malformed");
  if (
    record.contractVersion !== version &&
    !(
      record.operation === "entitlement.status" &&
      record.contractVersion === COMMUNITY_CONTRACT_VERSION
    )
  )
    return rejected("unsupported_contract");
  if (canonicalBytes(record) > 16384) return rejected("malformed");

  if (record.operation === "entitlement.status") {
    if (
      !(record.contractVersion === COMMUNITY_V2
        ? validV2Status(record)
        : validStatusQuery(record)) ||
      !operationId
    )
      return rejected("malformed");
    return { kind: "status", operationId };
  }
  const validCommand = version === COMMUNITY_V2 ? validV2Set : validSet;
  if (!validCommand(record) || !operationId) return rejected("malformed");
  const command = normalize(record, operationId);
  return {
    kind: "set",
    command,
    payloadDigest: digest(version === COMMUNITY_V2 ? record : command),
  };
}

function normalize(
  command: CommunitySetCommand,
  operationId: string,
): CommunitySetCommand {
  return {
    ...command,
    operationId,
    correlationRef: command.correlationRef.toLowerCase(),
    binding: {
      ...command.binding,
      linkRef: command.binding.linkRef.toLowerCase(),
    },
  };
}

function canonicalBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

export function assertCommunityResult(
  result: CommunityResult,
): CommunityResult {
  if (
    !(result.contractVersion === COMMUNITY_V2
      ? validV2Result(result)
      : validResult(result))
  )
    throw new Error("Community result violates the approved contract");
  return result;
}

export const communityErrorStatus: Readonly<
  Record<CommunityErrorCode, number>
> = Object.freeze({
  malformed: 400,
  unauthorized: 401,
  unsupported_contract: 422,
  not_found: 404,
  operation_conflict: 409,
  revision_conflict: 409,
  binding_conflict: 409,
  unavailable: 503,
});

export function communityError(
  operationId: string,
  error: CommunityErrorCode,
  version: CommunityVersion = COMMUNITY_CONTRACT_VERSION,
): CommunityError {
  return {
    contractVersion: version,
    operation: "entitlement.error",
    operationId,
    error,
  };
}

export function accessValidUntil(access: CommunityAccess): Date | null {
  return access.kind === "finite" ? new Date(access.validUntil) : null;
}

export function accessAllows(access: CommunityAccess, now: Date): boolean {
  if (access.kind === "denied") return false;
  if (access.kind === "lifetime") return true;
  return Date.parse(access.validUntil) > now.getTime();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
