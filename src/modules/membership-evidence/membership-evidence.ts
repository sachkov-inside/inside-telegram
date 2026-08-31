export const MEMBERSHIP_EVIDENCE_CONTRACT_VERSION =
  "inside.membership-evidence.v1" as const;

export type MembershipEvidence =
  | {
      readonly checkedAt: string;
      readonly contractVersion: typeof MEMBERSHIP_EVIDENCE_CONTRACT_VERSION;
      readonly decision: "member" | "not_member";
      readonly evidenceRef: string;
      readonly evidenceVersion: number;
      readonly principalRef: string;
      readonly reasonCode: "chat_member" | "chat_not_member";
      readonly telegramIdentityRef: string;
      readonly validUntil: string;
    }
  | {
      readonly contractVersion: typeof MEMBERSHIP_EVIDENCE_CONTRACT_VERSION;
      readonly decision: "unavailable";
      readonly principalRef: string;
      readonly reasonCode: "provider_unavailable";
    };

export function readStoredMembershipEvidence(
  value: unknown,
): MembershipEvidence {
  if (
    typeof value !== "object" ||
    value === null ||
    !("contractVersion" in value) ||
    value.contractVersion !== MEMBERSHIP_EVIDENCE_CONTRACT_VERSION ||
    !("principalRef" in value) ||
    typeof value.principalRef !== "string" ||
    !("decision" in value)
  ) {
    throw new Error("Stored Membership Evidence envelope is invalid");
  }
  if (
    value.decision === "unavailable" &&
    "reasonCode" in value &&
    value.reasonCode === "provider_unavailable"
  ) {
    return value as MembershipEvidence;
  }
  if (
    (value.decision === "member" || value.decision === "not_member") &&
    "checkedAt" in value &&
    typeof value.checkedAt === "string" &&
    "validUntil" in value &&
    typeof value.validUntil === "string" &&
    "telegramIdentityRef" in value &&
    typeof value.telegramIdentityRef === "string" &&
    "evidenceRef" in value &&
    typeof value.evidenceRef === "string" &&
    "evidenceVersion" in value &&
    typeof value.evidenceVersion === "number"
  ) {
    return value as MembershipEvidence;
  }
  throw new Error("Stored Membership Evidence envelope is invalid");
}
