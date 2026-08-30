import { describe, expect, it } from "vitest";

import {
  botHasMembershipPrerequisite,
  normalizeChatMember,
} from "../../src/modules/membership-evidence/membership-normalization.js";

describe("Membership Evidence normalization", () => {
  it.each([
    [{ status: "creator" }, "member"],
    [{ status: "administrator" }, "member"],
    [{ status: "member" }, "member"],
    [{ isMember: true, status: "restricted" }, "member"],
    [{ isMember: false, status: "restricted" }, "non_member"],
    [{ status: "left" }, "non_member"],
    [{ status: "kicked" }, "non_member"],
    [{ status: "future_status" }, "unavailable"],
  ] as const)("normalizes %o as %s", (chatMember, expected) => {
    expect(normalizeChatMember(chatMember)).toBe(expected);
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
