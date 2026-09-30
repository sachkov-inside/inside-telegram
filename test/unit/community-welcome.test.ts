import { describe, expect, it } from "vitest";
import { communityWelcomeMessage } from "../../src/modules/community/community-welcome.js";

describe("community welcome message", () => {
  it("puts the personal link on the last line without a stream date", () => {
    expect(communityWelcomeMessage("Welcome", "https://t.me/+x")).toBe(
      "Welcome\nhttps://t.me/+x",
    );
  });

  it("adds the Platform stream start before the link once it is supplied", () => {
    expect(
      communityWelcomeMessage("Welcome", "https://t.me/+x", {
        streamStartsOn: "2026-11-02",
      }),
    ).toBe("Welcome\nСтарт потока: 2 ноября 2026 г.\nhttps://t.me/+x");
  });
});
