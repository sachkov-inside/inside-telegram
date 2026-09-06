import { describe, expect, it } from "vitest";
import fixtures from "../../src/modules/communications/contracts/inside-communications-v1/fixtures.json" with { type: "json" };
import {
  contractValidator,
  validateContent,
} from "../../src/modules/communications/communications-contract.js";
import { translateTemplateIntake } from "../../src/adapters/telegram/grammy-template-intake.adapter.js";
import {
  GrammyUpdateAdapter,
  prepareTelegramUpdateForInbox,
} from "../../src/adapters/telegram/grammy-update.adapter.js";

const text = {
  type: "text",
  text: "😀 hello",
  entities: [{ type: "bold", offset: 3, length: 5 }],
  buttons: [],
};
describe("vendored communications contract", () => {
  for (const fixture of fixtures)
    it(fixture.name, () => {
      const validate = contractValidator(fixture.definition);
      expect(validate(fixture.value), JSON.stringify(validate.errors)).toBe(
        fixture.valid,
      );
    });
  it("preserves UTF-16 formatting and rejects offsets, unsupported entities and secret URLs", () => {
    expect(() => validateContent(text)).not.toThrow();
    const invalid = [
      {
        ...text,
        text: "https://api.telegram.org.:443/file/botSynthetic/file",
        entities: [],
      },
      {
        ...text,
        text: "https://%61pi.telegram.org/%66ile/botSynthetic/file",
        entities: [],
      },
      { ...text, entities: [{ type: "bold", offset: 1, length: 1 }] },
      { ...text, entities: [{ type: "bold", offset: 8, length: 1 }] },
      { ...text, entities: [{ type: "custom_emoji", offset: 0, length: 2 }] },
      { ...text, entities: [{ type: "text_link", offset: 3, length: 5 }] },
      { ...text, text: "x".repeat(4097) },
      { ...text, text: "😀".repeat(2049), entities: [] },
      {
        ...text,
        buttons: [
          {
            text: "Secret",
            url: "https://api.telegram.org./file/botSynthetic/file",
          },
        ],
      },
      { ...text, buttons: [{ text: "Invalid", url: "https://%zz" }] },
      { ...text, text: "https://api.telegram.org/file/botSynthetic/file" },
      {
        ...text,
        buttons: [
          {
            text: "Secret",
            url: "https://api.telegram.org/file/botSynthetic/file",
          },
        ],
      },
      { ...text, buttons: [{ text: "Unsafe", url: "javascript:alert(1)" }] },
      {
        ...text,
        entities: [
          { type: "bold", offset: 3, length: 3 },
          { type: "italic", offset: 4, length: 4 },
        ],
      },
      { ...text, type: "video_note", fileId: "synthetic" },
    ];
    for (const value of invalid)
      expect(() => validateContent(value)).toThrow("unsupported_content");
  });
  it("preserves bare-domain Telegram URL entities and gives an explicit error for malformed URLs", () => {
    const value = {
      ...text,
      text: "example.com",
      entities: [{ type: "url", offset: 0, length: 11 }],
    };
    expect(() => validateContent(value)).not.toThrow();
    expect(value.text).toBe("example.com");
    expect(() => validateContent({ ...value, text: "https://%zz" })).toThrow(
      "unsupported_content",
    );
    expect(() =>
      validateContent({ ...text, text: "😀".repeat(2048), entities: [] }),
    ).not.toThrow();
  });
  it("never captures auth/link/sign-in starts, callbacks, edits or unverified senders", () => {
    const adapter = new GrammyUpdateAdapter();
    for (const payload of [
      "",
      "a".repeat(43),
      "signin_" + "a".repeat(35),
      "signin_broken",
      "bad+token",
      "signin_" + "a".repeat(43),
    ]) {
      const update = message(`/start ${payload}`.trim());
      expect(translateTemplateIntake("inside", "1", update)).toBeUndefined();
      expect(
        adapter.translate(
          "inside",
          "1",
          prepareTelegramUpdateForInbox(update),
          new Date(),
        ).kind,
      ).toBe("start");
    }
    for (const update of [
      { edited_message: message("changed").message },
      {
        callback_query: { data: "signin:approve:synthetic", from: { id: 42 } },
      },
      {
        message: {
          ...message("hello").message,
          from: { id: 43, is_bot: false },
        },
      },
      {
        message: {
          ...message("hello").message,
          from: { id: 42, is_bot: true },
        },
      },
    ])
      expect(translateTemplateIntake("inside", "1", update)).toBeUndefined();
  });
  it("explicitly rejects albums, polls and unsupported formatting without losing parts", () => {
    for (const extra of [
      { media_group_id: "synthetic" },
      { poll: {} },
      { animation: {} },
      {
        entities: [
          { type: "text_mention", offset: 0, length: 1, user: { id: 42 } },
        ],
      },
    ]) {
      const value = translateTemplateIntake("inside", "1", {
        message: { ...message("hello").message, ...extra },
      })!;
      expect(() => validateContent(value.content)).toThrow(
        "unsupported_content",
      );
    }
  });
});
function message(text: string) {
  return {
    message: {
      text,
      from: { id: 42, is_bot: false },
      chat: { id: 42, type: "private" },
    },
  };
}
