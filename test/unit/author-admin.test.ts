import { parseFunnelDelay } from "../../src/modules/communications/author-funnels.js";
import { describe, expect, it } from "vitest";
import { translateAuthorInput } from "../../src/adapters/telegram/grammy-author-admin.adapter.js";
import { snapshot } from "../../src/adapters/telegram/grammy-template-intake.adapter.js";
import { parseMoscowSchedule } from "../../src/modules/communications/author-admin.js";
import { buttonRows } from "../../src/modules/communications/button-rows.js";
import { validateContent } from "../../src/modules/communications/communications-contract.js";

describe("native author input", () => {
  const callback = {
    id: "query",
    from: { id: 42, is_bot: false },
    message: { chat: { id: 42, type: "private" } },
    data: "author:menu:0",
  };
  it("accepts only a human's private author callback, preserving the separate sign-in namespace", () => {
    expect(
      translateAuthorInput("inside", "1", { callback_query: callback })
        ?.callbackData,
    ).toBe(callback.data);
    for (const changed of [
      { ...callback, data: "sign-in:yes" },
      { ...callback, from: { id: 43, is_bot: false } },
      { ...callback, from: { id: 42, is_bot: true } },
      { ...callback, message: { chat: { id: 42, type: "group" } } },
    ])
      expect(
        translateAuthorInput("inside", "1", { callback_query: changed }),
      ).toBeUndefined();
    expect(
      translateAuthorInput("inside", "1", {
        edited_message: { text: "/admin" },
      }),
    ).toBeUndefined();
  });
  it("preserves native keyboard rows and rejects unsupported markup", () => {
    const content = snapshot({
      text: "Post",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "A", url: "https://example.com/a" },
            { text: "B", url: "https://example.com/b" },
          ],
          [{ text: "C", url: "https://example.com/c" }],
        ],
      },
    });
    validateContent(content);
    expect(
      buttonRows(content.buttons).map((row) => row.map((b) => b.text)),
    ).toEqual([["A", "B"], ["C"]]);
    expect(
      buttonRows(content.buttons.map(({ text, url }) => ({ text, url }))).map(
        (row) => row.length,
      ),
    ).toEqual([1, 1, 1]);
    expect(
      snapshot({
        text: "Post",
        reply_markup: {
          inline_keyboard: [[{ text: "A", callback_data: "unsafe" }]],
        },
      }),
    ).toBeNull();
    expect(() =>
      validateContent({
        ...content,
        buttons: Array.from({ length: 9 }, () => ({
          text: "A",
          url: "https://example.com",
          row: 0,
        })),
      }),
    ).toThrow("unsupported_content");
  });
  it("parses explicit Moscow time without accepting invalid dates or implicit machine timezones", () => {
    expect(parseMoscowSchedule("01.01.2099 12:00")).toBe(
      "2099-01-01T09:00:00.000Z",
    );
    expect(parseMoscowSchedule("сразу")).toBeNull();
    for (const input of [
      "31.02.2099 12:00",
      "01.01.2099 25:00",
      "tomorrow",
      "2099-01-01",
    ])
      expect(parseMoscowSchedule(input)).toBeUndefined();
  });
});

it.each([
  ["20 МИНУТ", 1200],
  ["1 ДЕНЬ", 86400],
  ["2 Часа", 7200],
  ["2 дня", 172800],
  ["10 секунд", 10],
])("parses human delay %s consistently", (value, seconds) => {
  expect(parseFunnelDelay(String(value))).toBe(seconds);
});
