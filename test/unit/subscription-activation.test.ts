import { ownAccessText } from "../../src/modules/subscription-activation/activation-view.js";
import type { OwnAccess } from "../../src/modules/subscription-activation/activation-contract.js";
import { describe, expect, it } from "vitest";
import {
  GrammyUpdateAdapter,
  prepareTelegramUpdateForInbox,
} from "../../src/adapters/telegram/grammy-update.adapter.js";
import { SourceGroupProof } from "../../src/modules/subscription-activation/source-group-proof.js";
import { activationValidator } from "../../src/modules/subscription-activation/activation-contract.js";
import { loadActivationConfig } from "../../src/config/activation-config.js";
import fixtures from "../../docs/contracts/subscription-activation-v1/fixtures.json" with { type: "json" };
import { privateStartUpdate } from "../support/synthetic-telegram-updates.js";

describe("activation ingress and separate source proof", () => {
  for (const fixture of fixtures)
    it(`accepts the portable verdict: ${fixture.name}`, () =>
      expect(activationValidator(fixture.definition)(fixture.value)).toBe(
        fixture.valid,
      ));
  it("isolates short activation codes from legacy tokens and strips synthetic metadata", () => {
    const adapter = new GrammyUpdateAdapter();
    const translate = (text: string) =>
      adapter.translate(
        "inside",
        "1",
        prepareTelegramUpdateForInbox(privateStartUpdate(1, 42, { text })),
        new Date(),
      );
    expect(translate("/start a_course")).toMatchObject({
      kind: "start",
      value: { activationCode: "course" },
    });
    expect(translate(`/start a_${"x".repeat(41)}`)).toMatchObject({
      kind: "start",
      value: { linkToken: { kind: "digest" } },
    });
    expect(translate("/start a_invalid!")).toMatchObject({
      kind: "start",
      value: { activationCode: null },
    });
    const forged = privateStartUpdate(1, 42);
    Object.assign(forged.message, { _inside_activation: { code: "course" } });
    expect(
      adapter.translate(
        "inside",
        "1",
        prepareTelegramUpdateForInbox(forged),
        new Date(),
      ),
    ).not.toHaveProperty("value.activationCode");
    expect(translate(`/start signin_${"x".repeat(35)}`)).toHaveProperty(
      "value.signInToken",
    );
    expect(translate("/start m_video")).toHaveProperty(
      "value.marketingSource",
      "m_video",
    );
  });
  it.each([
    ["member", undefined, "member"],
    ["administrator", undefined, "member"],
    ["creator", undefined, "member"],
    ["restricted", true, "member"],
    ["restricted", false, "not_member"],
    ["left", undefined, "not_member"],
    ["kicked", undefined, "not_member"],
    ["future_status", undefined, "unavailable"],
  ] as const)(
    "normalizes source %s/%s without canonical evidence",
    async (status, isMember, decision) => {
      const chats: string[] = [];
      const proof = new SourceGroupProof(
        [{ sourceRef: "course", chatId: "-2", policy: "whole_group" }],
        {
          async getBotChatMember(chat) {
            chats.push(chat);
            return { kind: "observed", value: { status: "administrator" } };
          },
          async getChatMember(chat) {
            chats.push(chat);
            return {
              kind: "observed",
              value: {
                status,
                ...(isMember !== undefined ? { isMember } : {}),
              },
            };
          },
        },
      );
      expect(await proof.check("course", "identity", "42")).toEqual({
        decision,
      });
      expect(chats).toEqual(["-2", "-2"]);
    },
  );
  it("preserves unavailable and retry_after, and rejects guests in confirmed_list", async () => {
    const proof = new SourceGroupProof(
      [
        {
          sourceRef: "course",
          chatId: "-2",
          policy: "confirmed_list",
          confirmedIdentityRefs: ["buyer"],
        },
      ],
      {
        async getBotChatMember() {
          return {
            kind: "unavailable",
            diagnosticCode: "rate_limited",
            retryAfterSeconds: 125,
          };
        },
        async getChatMember() {
          throw new Error("must not run");
        },
      },
    );
    expect(await proof.check("course", "guest", "42")).toEqual({
      decision: "not_member",
    });
    expect(await proof.check("course", "buyer", "42")).toEqual({
      decision: "unavailable",
      retryAfterSeconds: 125,
    });
    expect(await proof.check("unknown", "buyer", "42")).toEqual({
      decision: "unavailable",
    });
  });
  it("rejects canonical source aliases and shared credentials", () => {
    const env = {
      TELEGRAM_ACTIVATION_ENABLED: "true",
      PLATFORM_ACTIVATION_URL: "https://platform.example/activation",
      PLATFORM_ACCOUNT_URL: "https://platform.example/account",
      PLATFORM_ACTIVATION_SECRET: "a".repeat(32),
      TELEGRAM_ACTIVATION_SOURCES: JSON.stringify([
        { sourceRef: "course", chatId: "-1", policy: "whole_group" },
      ]),
    };
    expect(() => loadActivationConfig(env, [], "-1")).toThrow();
    expect(() =>
      loadActivationConfig(
        { ...env, TELEGRAM_ACTIVATION_SOURCES: "[]" },
        [env.PLATFORM_ACTIVATION_SECRET],
        "-1",
      ),
    ).toThrow();
  });
});

it("keeps admission restriction and cabinet guidance visible with maximum-length access details", () => {
  const access: OwnAccess = {
    contractVersion: "inside.subscription-activation.v1",
    enrollments: Array.from({ length: 8 }, (_, index) => ({
      id: String(index),
      tier: {
        name: "Длинное имя тарифа ".repeat(15),
        benefits: ["materials", "community", "support", "reviews"],
      },
      origin: "course",
      startsAt: "2026-09-14T10:00:00.000Z",
      endsAt: null,
      state: "active",
      renewal: "not_applicable",
      benefitTerms: Array.from({ length: 20 }, () => ({
        capability: "community",
        startsAt: "2026-09-14T10:00:00.000Z",
        endsAt: null,
        revoked: false,
      })),
    })),
    grounds: [],
    admission: { state: "checking", admissionRestriction: "external_unknown" },
  };
  const text = ownAccessText(access);
  expect(text.length).toBeLessThanOrEqual(3900);
  expect(text).toContain("Вступление ограничено");
  expect(text).toContain(
    "Срок каждого отдельного права, полный состав и история — в кабинете.",
  );
});
