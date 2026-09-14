import type {
  BindingResponse,
  ActivationBegin,
  ActivationBinding,
  ActivationEvidence,
  ActivationResponse,
  ActivationResult,
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
}
export const ACTIVATION_PLATFORM = Symbol("ACTIVATION_PLATFORM");
