import { randomUUID } from "node:crypto";
import type { AuthorSubject } from "../../modules/communications/author-authorization.js";
import type {
  AuthorContentValidation,
  AuthorContentValidationResult,
  ContentTargetError,
} from "../../modules/communications/author-content-validation.js";
import {
  COMMUNICATIONS_VERSION,
  contractValidator,
} from "../../modules/communications/communications-contract.js";
import type { MessagePart } from "../../modules/communications/funnel-types.js";

const validRequest = contractValidator("contentValidationRequest");
const validResponse = contractValidator("contentValidationResponse");
export class HttpAuthorContentValidationAdapter implements AuthorContentValidation {
  constructor(
    private readonly endpoint: string,
    private readonly secret: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async validate(
    subject: AuthorSubject,
    parts: readonly MessagePart[],
  ): Promise<AuthorContentValidationResult> {
    const requestId = randomUUID();
    const request = {
      contractVersion: COMMUNICATIONS_VERSION,
      permission: "communications:manage",
      requestId,
      subject,
      parts,
    };
    if (!validRequest(request)) return { status: "unavailable" };
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
      if (response.status === 401 || response.status === 403)
        return { status: "denied" };
      if (!response.ok) return { status: "unavailable" };
      const body: unknown = await response.json();
      if (!validResponse(body)) return { status: "unavailable" };
      const result = body as {
        requestId: string;
        status: "ok" | "denied";
        accountRef?: string;
        targetErrors: ContentTargetError[];
      };
      if (result.requestId !== requestId) return { status: "unavailable" };
      if (
        result.status === "denied" ||
        result.accountRef !== subject.accountRef
      )
        return { status: "denied" };
      return { status: "ok", targetErrors: result.targetErrors };
    } catch {
      return { status: "unavailable" };
    }
  }
}
