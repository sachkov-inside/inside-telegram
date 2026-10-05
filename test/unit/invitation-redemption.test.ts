import { describe, expect, it } from "vitest";
import {
  GrammyUpdateAdapter,
  prepareTelegramUpdateForInbox,
} from "../../src/adapters/telegram/grammy-update.adapter.js";
import { HttpActivationPlatform } from "../../src/adapters/platform/http-activation-platform.adapter.js";
import {
  ACTIVATION_VERSION,
  type ActivationResponse,
  type ActivationResult,
} from "../../src/modules/subscription-activation/activation-contract.js";
import { activationMessage } from "../../src/modules/subscription-activation/activation-view.js";
import { invitationAnswer } from "../../src/modules/subscription-activation/invitation-view.js";
import fixtures from "../../docs/contracts/subscription-activation-v1/fixtures.json" with { type: "json" };
import { privateStartUpdate } from "../support/synthetic-telegram-updates.js";
import { requestBody } from "../support/json.js";

const adapter = new GrammyUpdateAdapter();
function translate(text: string) {
  return adapter.translate(
    "inside",
    "1",
    prepareTelegramUpdateForInbox(privateStartUpdate(1, 42, { text })),
    new Date(),
  );
}

describe("invitation start payload", () => {
  it("reads i_<code> next to a_ and m_ without touching legacy tokens", () => {
    expect(translate("/start i_Ab3-_x")).toMatchObject({
      kind: "start",
      value: { invitationCode: "Ab3-_x" },
    });
    expect(translate(`/start i_${"x".repeat(40)}`)).toMatchObject({
      value: { invitationCode: "x".repeat(40) },
    });
    expect(translate("/start i_bad!")).toMatchObject({
      value: { invitationCode: null },
    });
    // 43 characters and more stay a legacy link token, as for a_ and m_.
    expect(translate(`/start i_${"x".repeat(41)}`)).toMatchObject({
      value: { linkToken: { kind: "digest" } },
    });
    expect(translate(`/start i_${"x".repeat(41)}`)).not.toHaveProperty(
      "value.invitationCode",
    );
    expect(translate("/start a_course")).not.toHaveProperty(
      "value.invitationCode",
    );
  });

  it("keeps the code out of the stored message text and ignores a forged field", () => {
    const stored = prepareTelegramUpdateForInbox(
      privateStartUpdate(1, 42, { text: "/start i_secretcode" }),
    );
    expect(stored).toMatchObject({ message: { text: "/start" } });
    expect(JSON.stringify(stored)).not.toContain("i_secretcode");

    const forged = privateStartUpdate(1, 42);
    Object.assign(forged.message, { _inside_invitation: { code: "forged" } });
    expect(
      adapter.translate(
        "inside",
        "1",
        prepareTelegramUpdateForInbox(forged),
        new Date(),
      ),
    ).not.toHaveProperty("value.invitationCode");
  });
});

describe("invitation redeem HTTP consumer", () => {
  for (const fixture of fixtures.filter(
    (f) => f.definition === "invitationRedeemResponse",
  )) {
    it(`decodes provider corpus: ${fixture.name}`, async () => {
      const platform = new HttpActivationPlatform(
        "https://platform.example/integrations/telegram/v1/subscription-activation",
        "synthetic-activation-secret",
        (url, init) => {
          expect(url).toBe(
            "https://platform.example/integrations/telegram/v1/invitations/redeem",
          );
          expect(init).toMatchObject({
            method: "POST",
            redirect: "error",
            headers: { authorization: "Bearer synthetic-activation-secret" },
          });
          expect(JSON.parse(requestBody(init))).toEqual({
            contractVersion: ACTIVATION_VERSION,
            code: "invite",
            identityRef: "synthetic-identity",
          });
          return Promise.resolve(Response.json(fixture.value));
        },
      );
      expect(
        await platform.redeem({
          contractVersion: ACTIVATION_VERSION,
          code: "invite",
          identityRef: "synthetic-identity",
        }),
      ).toEqual(fixture.valid ? fixture.value : undefined);
    });
  }
});

describe("course activation refusal", () => {
  it("asks a course student who is not in the group to write to the author", () => {
    const refusals: ActivationResult<ActivationResponse>[] = [
      {
        ok: true as const,
        value: {
          contractVersion: ACTIVATION_VERSION,
          attemptId: "a",
          state: "rejected" as const,
          enrollment: null,
        },
      },
      {
        ok: false as const,
        error: { code: "source_not_confirmed" as const },
      },
    ];
    for (const result of refusals)
      expect(activationMessage(result)).toContain("напишите автору");
  });
});

describe("invitation answer", () => {
  const gift = (endsAt: string | null) =>
    invitationAnswer(
      {
        ok: true,
        value: {
          contractVersion: ACTIVATION_VERSION,
          state: "already_redeemed",
          mode: "gift",
          offerName: "Подписка Inside",
          enrollment: { id: "e", tier: { name: "Подписка Inside" }, endsAt },
        },
      },
      new Date("2030-05-01T00:00:00Z"),
    );
  it("does not lead to the community after a gift has ended", () => {
    const ended = gift("2030-04-01T00:00:00.000Z");
    expect(ended.text).toContain("закончился");
    expect(ended.text).toContain("Напишите автору");
    expect(ended.buttons).toBeUndefined();
    expect(gift(null).buttons).toEqual([
      { text: "Вступить в сообщество", callbackData: "access:community" },
    ]);
    expect(gift("2030-06-01T00:00:00.000Z").text).toContain("/community");
  });
});
