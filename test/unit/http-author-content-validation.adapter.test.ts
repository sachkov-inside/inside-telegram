import { describe, expect, it, vi } from "vitest";
import { HttpAuthorContentValidationAdapter } from "../../src/adapters/platform/http-author-content-validation.adapter.js";
import { contractValidator } from "../../src/modules/communications/communications-contract.js";
const subject = {
  kind: "telegram" as const,
  accountRef: "synthetic-author",
  telegramIdentityRef: "synthetic-identity",
  botIdentity: "inside",
};
const parts = [
  {
    partId: "22222222-2222-4222-8222-222222222222",
    content: {
      type: "text" as const,
      text: "Read https://inside.test/materials/missing",
      entities: [],
      buttons: [],
    },
  },
];
const endpoint =
  "https://platform.test/integrations/telegram/v1/communications/validate-content";

describe("Platform content snapshot validation seam", () => {
  it("sends the exact snapshot with the confirmed author and retains validation reasons", async () => {
    const targetErrors = [
      {
        url: "https://inside.test/materials/missing",
        targetId: null,
        reason: "not_found",
      },
    ];
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe(endpoint);
      expect(init?.headers).toEqual({
        authorization: "Bearer synthetic-secret",
        "content-type": "application/json",
      });
      expect(init?.redirect).toBe("error");
      const request = JSON.parse(String(init?.body)) as {
        requestId: string;
        subject: unknown;
        parts: unknown;
      };
      expect(contractValidator("contentValidationRequest")(request)).toBe(true);
      expect(request.subject).toEqual(subject);
      expect(request.parts).toEqual(parts);
      return Response.json({
        contractVersion: "inside-communications-v1",
        requestId: request.requestId,
        status: "ok",
        accountRef: subject.accountRef,
        targetErrors,
      });
    });
    expect(
      await new HttpAuthorContentValidationAdapter(
        endpoint,
        "synthetic-secret",
        fetcher,
      ).validate(subject, parts),
    ).toEqual({ status: "ok", targetErrors });
  });
  it("fails closed for forged, stale, incomplete, revoked and unavailable decisions", async () => {
    for (const mode of [
      "forged",
      "stale",
      "missing-errors",
      "denied",
      "unavailable",
      "redirect",
      "version",
    ]) {
      const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
        if (mode === "unavailable") throw new Error("synthetic-secret");
        if (mode === "redirect") return new Response(null, { status: 302 });
        const request = JSON.parse(String(init?.body)) as { requestId: string };
        return Response.json({
          contractVersion:
            mode === "version" ? "v0" : "inside-communications-v1",
          requestId:
            mode === "stale"
              ? "33333333-3333-4333-8333-333333333333"
              : request.requestId,
          status: mode === "denied" ? "denied" : "ok",
          ...(mode === "denied"
            ? {}
            : {
                accountRef: mode === "forged" ? "foreign" : subject.accountRef,
                ...(mode === "missing-errors" ? {} : { targetErrors: [] }),
              }),
        });
      });
      expect(
        (
          await new HttpAuthorContentValidationAdapter(
            endpoint,
            "synthetic-secret",
            fetcher,
          ).validate(subject, parts)
        ).status,
      ).not.toBe("ok");
    }
  });
});
