import type {
  BindingResponse,
  ActivationBegin,
  ActivationBinding,
  ActivationEvidence,
  ActivationResponse,
  ActivationResult,
  InvitationRedeem,
  InvitationRedeemResponse,
  OwnAccess,
} from "./activation-contract.js";
export interface ActivationPlatform {
  binding(identityRef: string): Promise<BindingResponse | undefined>;
  begin(
    input: ActivationBegin,
  ): Promise<ActivationResult<ActivationResponse> | undefined>;
  evidence(
    input: ActivationEvidence,
  ): Promise<ActivationResult<ActivationResponse> | undefined>;
  own(
    binding: ActivationBinding,
  ): Promise<ActivationResult<OwnAccess> | undefined>;
  /** Idempotent by `(code, identityRef)`: a lost answer is retried with the same input. */
  redeem(
    input: InvitationRedeem,
  ): Promise<InvitationRedeemResponse | undefined>;
}
export const ACTIVATION_PLATFORM = Symbol("ACTIVATION_PLATFORM");
