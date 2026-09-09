import {
  validDispatchResponse,
  type DispatchRequest,
  type DispatchResponse,
} from "../../modules/notifications/notification-contract.js";
import type { NotificationAuthorization } from "../../modules/notifications/notification-ports.js";
export class HttpNotificationAuthorization implements NotificationAuthorization {
  constructor(
    private readonly endpoint: string,
    private readonly secret: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async authorize(
    request: DispatchRequest,
  ): Promise<DispatchResponse | undefined> {
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
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.byteLength;
          if (size > 16384) return;
          chunks.push(item.value);
        }
      } finally {
        await reader.cancel();
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!validDispatchResponse(value)) return;
      const result = value as DispatchResponse;
      if (
        !Object.entries(request).every(
          ([k, v]) => result[k as keyof DispatchRequest] === v,
        )
      )
        return;
      const expected =
        result.status === "error"
          ? (
              {
                malformed: 400,
                unauthorized: 401,
                unsupported_contract: 422,
                operation_conflict: 409,
                unavailable: 503,
              } as Record<string, number>
            )[result.code]
          : 200;
      if (response.status !== expected) return;
      return result;
    } catch {
      return;
    }
  }
}
