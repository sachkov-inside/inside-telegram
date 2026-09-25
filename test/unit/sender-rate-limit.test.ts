import { describe, expect, it } from "vitest";

import { SenderRateLimit } from "../../src/modules/update-inbox/sender-rate-limit.js";

const at = (seconds: number): Date =>
  new Date(Date.UTC(2026, 8, 25, 12, 0, seconds));

describe("SenderRateLimit", () => {
  it("admits a sender's requests up to the limit and refuses the rest of the window", () => {
    const limit = new SenderRateLimit({ requests: 3, windowMs: 10_000 });

    expect(
      ["1", "2", "3", "4", "5"].map((updateId) =>
        limit.admit("user-a", updateId, at(0)),
      ),
    ).toEqual(["admitted", "admitted", "admitted", "notify", "silent"]);
  });

  it("frees a request once it leaves the sliding window and notifies again in a new window", () => {
    const limit = new SenderRateLimit({ requests: 2, windowMs: 10_000 });

    // Window (t - 10 s, t]; a notice again only after the previous one has left the window.
    expect(
      [0, 5, 9, 10, 11, 15, 18, 19].map((second, index) =>
        limit.admit("user-a", String(index + 1), at(second)),
      ),
    ).toEqual([
      "admitted",
      "admitted",
      "notify",
      "admitted",
      "silent",
      "admitted",
      "silent",
      "notify",
    ]);
  });

  it("gives a retried update its first decision without counting it again", () => {
    const limit = new SenderRateLimit({ requests: 2, windowMs: 10_000 });

    expect([
      limit.admit("user-a", "1", at(0)),
      limit.admit("user-a", "1", at(0)),
      limit.admit("user-a", "2", at(1)),
      limit.admit("user-a", "3", at(2)),
      limit.admit("user-a", "3", at(2)),
      limit.admit("user-a", "4", at(3)),
      limit.admit("user-a", "2", at(1)),
    ]).toEqual([
      "admitted",
      "admitted",
      "admitted",
      "notify",
      "notify",
      "silent",
      "admitted",
    ]);
  });

  it("limits each sender separately and forgets senders idle for a whole window", () => {
    const limit = new SenderRateLimit({ requests: 1, windowMs: 10_000 });

    expect([
      limit.admit("user-a", "1", at(0)),
      limit.admit("user-a", "2", at(1)),
      limit.admit("user-b", "3", at(2)),
    ]).toEqual(["admitted", "notify", "admitted"]);
    expect(limit.trackedSenders).toBe(2);

    expect(limit.admit("user-c", "4", at(12))).toBe("admitted");
    expect(limit.trackedSenders).toBe(1);
  });
});
