import { randomUUID } from "node:crypto";
import type {
  AuthorAuthorization,
  AuthorSubject,
} from "../../modules/communications/author-authorization.js";
import {
  COMMUNICATIONS_VERSION,
  contractValidator,
} from "../../modules/communications/communications-contract.js";
const validResponse = contractValidator("authorizationResponse");
export class HttpAuthorAuthorizationAdapter implements AuthorAuthorization {
  constructor(
    private readonly endpoint: string,
    private readonly secret: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async authorize(
    subject: AuthorSubject,
  ): Promise<"allowed" | "denied" | "unavailable"> {
    const requestId = randomUUID();
    try {
      const response = await this.fetcher(this.endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
        headers: {
          authorization: `Bearer ${this.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          contractVersion: COMMUNICATIONS_VERSION,
          requestId,
          permission: "communications:manage",
          subject,
        }),
      });
      if (response.status === 401 || response.status === 403) return "denied";
      if (!response.ok) return "unavailable";
      const body: unknown = await response.json();
      if (!validResponse(body)) return "unavailable";
      const result = body as {
        requestId: string;
        status: "allowed" | "denied";
        accountRef?: string;
      };
      if (result.requestId !== requestId) return "unavailable";
      if (result.status === "denied") return "denied";
      return result.accountRef === subject.accountRef ? "allowed" : "denied";
    } catch {
      return "unavailable";
    }
  }
}
