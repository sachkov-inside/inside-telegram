import { describe, expect, it } from "vitest";

import { toTelegramChatMember } from "../../src/adapters/telegram/grammy-membership.adapter.js";
import corpus from "../../src/modules/membership-evidence/contracts/membership-normalization-v1/fixtures.json" with { type: "json" };
import {
  botHasMembershipPrerequisite,
  normalizeChatMember,
} from "../../src/modules/membership-evidence/membership-normalization.js";

describe("Membership Evidence normalization", () => {
  it.each(corpus.fixtures)(
    "normalizes direct and future event representation: $name",
    (fixture) => {
      expect(normalizeChatMember(toTelegramChatMember(fixture.direct))).toBe(
        fixture.expected,
      );
      expect(
        normalizeChatMember(
          toTelegramChatMember(fixture.event.new_chat_member),
        ),
      ).toBe(fixture.expected);
    },
  );

  it("pins the shared corpus version for later event ingestion", () => {
    expect(corpus.fixtureVersion).toBe(
      "inside.telegram-membership-normalization.v1",
    );
  });

  it.each([
    ["creator", true],
    ["administrator", true],
    ["member", false],
    ["restricted", false],
    ["left", false],
    ["kicked", false],
    ["future_status", false],
  ] as const)(
    "treats bot status %s administrator prerequisite as %s",
    (status, expected) => {
      expect(botHasMembershipPrerequisite({ status })).toBe(expected);
    },
  );
});
