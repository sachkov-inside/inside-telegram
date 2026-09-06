import { describe, expect, it, vi } from "vitest";
import { HttpAuthorAuthorizationAdapter } from "../../src/adapters/platform/http-author-authorization.adapter.js";
import { contractValidator } from "../../src/modules/communications/communications-contract.js";
const subject = {
  kind: "telegram" as const,
  accountRef: "synthetic-author",
  telegramIdentityRef: "synthetic-identity",
  botIdentity: "inside",
};
describe("Platform author authorization seam", () => {
  it("authenticates, binds the decision and never follows redirects", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.headers).toEqual({
        authorization: "Bearer synthetic-secret",
        "content-type": "application/json",
      });
      expect(init?.redirect).toBe("error");
      const request = JSON.parse(String(init?.body)) as { requestId: string };
      expect(contractValidator("authorizationRequest")(request)).toBe(true);
      return Response.json({
        contractVersion: "inside-communications-v1",
        requestId: request.requestId,
        status: "allowed",
        accountRef: subject.accountRef,
      });
    });
    await expect(
      new HttpAuthorAuthorizationAdapter(
        "https://platform.example.test/authorize",
        "synthetic-secret",
        fetcher,
      ).authorize(subject),
    ).resolves.toBe("allowed");
  });
  it("fails closed for revoked, spoofed, stale, malformed and unavailable responses", async () => {
    for (const mode of [
      "denied",
      "forged",
      "stale",
      "malformed",
      "unavailable",
      "redirect",
    ]) {
      const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
        if (mode === "unavailable") throw new Error("synthetic-secret");
        if (mode === "redirect") return new Response(null, { status: 302 });
        const request = JSON.parse(String(init?.body)) as { requestId: string };
        return Response.json({
          contractVersion:
            mode === "malformed" ? "v0" : "inside-communications-v1",
          requestId:
            mode === "stale"
              ? "11111111-1111-4111-8111-111111111111"
              : request.requestId,
          status: mode === "denied" ? "denied" : "allowed",
          ...(mode !== "denied"
            ? { accountRef: mode === "forged" ? "other" : subject.accountRef }
            : {}),
        });
      });
      expect(
        await new HttpAuthorAuthorizationAdapter(
          "https://platform.example.test/authorize",
          "synthetic-secret",
          fetcher,
        ).authorize(subject),
      ).not.toBe("allowed");
    }
  });
});
