import {
  validBindingResponse,
  type BindingResponse,
  ACTIVATION_VERSION,
  validActivationResponse,
  validOwnAccessResponse,
  type ActivationBegin,
  type ActivationBinding,
  type ActivationEvidence,
  type ActivationResponse,
  type ActivationResult,
  type OwnAccess,
} from "../../modules/subscription-activation/activation-contract.js";
import type { ActivationPlatform } from "../../modules/subscription-activation/activation-ports.js";
import type { ValidateFunction } from "ajv";

/** Only the source-authority secret crosses this boundary; redirects are forbidden. */
export class HttpActivationPlatform implements ActivationPlatform {
  constructor(
    private readonly endpoint: string,
    private readonly secret: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  binding(identityRef: string): Promise<BindingResponse | undefined> {
    return this.post(
      "binding",
      { contractVersion: ACTIVATION_VERSION, identityRef },
      validBindingResponse,
    );
  }
  begin(
    input: ActivationBegin,
  ): Promise<ActivationResult<ActivationResponse> | undefined> {
    return this.post("attempts", input, validActivationResponse);
  }
  evidence(
    input: ActivationEvidence,
  ): Promise<ActivationResult<ActivationResponse> | undefined> {
    // PostgreSQL jsonb reorders keys. Keep the same wire bytes on initial send
    // and durable replay without changing any evidence values or references.
    const ordered = Object.fromEntries(
      Object.keys(input)
        .sort()
        .map((key) => [key, input[key as keyof ActivationEvidence]]),
    );
    return this.post("evidence", ordered, validActivationResponse);
  }
  own(
    binding: ActivationBinding,
  ): Promise<ActivationResult<OwnAccess> | undefined> {
    return this.post(
      "own-access",
      { contractVersion: ACTIVATION_VERSION, ...binding },
      validOwnAccessResponse,
    );
  }
  private async post<T>(
    path: string,
    input: unknown,
    validate: ValidateFunction,
  ): Promise<T | undefined> {
    try {
      const response = await this.fetcher(`${this.endpoint}/${path}`, {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
        headers: {
          authorization: `Bearer ${this.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      });
      if (
        response.status !== 200 ||
        !response.body ||
        response.headers.get("content-type")?.split(";")[0] !==
          "application/json"
      )
        return;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 1_048_576) return;
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel();
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return validate(body) ? (body as T) : undefined;
    } catch {
      return;
    }
  }
}
