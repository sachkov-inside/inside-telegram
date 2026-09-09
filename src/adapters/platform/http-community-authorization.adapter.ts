import {
  validDispatchResponse,
  type DispatchAuthorizationRequest,
  type DispatchAuthorizationResponse,
} from "../../modules/community/community-contract.js";
import type { CommunityDispatchAuthorization } from "../../modules/community/community-ports.js";

const ERROR_STATUS: Readonly<Record<string, number>> = {
  malformed: 400,
  unauthorized: 401,
  unsupported_contract: 422,
  not_found: 404,
  operation_conflict: 409,
  revision_conflict: 409,
  binding_conflict: 409,
  unavailable: 503,
};

/**
 * Checks both the HTTP status and the body. A mismatch is an invalid provider
 * response, never a repeated effect.
 */
export class HttpCommunityAuthorization implements CommunityDispatchAuthorization {
  constructor(
    private readonly endpoint: string,
    private readonly secret: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async authorize(
    request: DispatchAuthorizationRequest,
  ): Promise<DispatchAuthorizationResponse | undefined> {
    try {
      const response = await this.fetcher(this.endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
        headers: {
          authorization: `Bearer ${this.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
      });
      if (
        !response.body ||
        response.headers.get("content-type")?.split(";")[0] !==
          "application/json"
      )
        return;
      const body = await readBounded(response.body);
      if (!body) return;
      const value: unknown = JSON.parse(body);
      if (!validDispatchResponse(value)) return;
      const result = value as DispatchAuthorizationResponse;
      if (result.operationId !== request.operationId) return;
      if (result.operation === "dispatch.error") {
        return response.status === ERROR_STATUS[result.error]
          ? result
          : undefined;
      }
      if (
        response.status !== 200 ||
        result.dispatchId !== request.dispatchId ||
        result.attemptId !== request.attemptId
      )
        return;
      return result;
    } catch {
      return;
    }
  }
}

async function readBounded(
  body: ReadableStream<Uint8Array>,
): Promise<string | undefined> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 16384) return;
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks).toString("utf8");
}
