import type { Context, Action } from "./author-admin.js";
import type { MessageDestination } from "./author-composer.js";
import { parseFunnelDelay, formatFunnelDelay } from "./author-funnels.js";
import {
  validateContent,
  type TemplateContent,
} from "./communications-contract.js";

type Reply = (text: string, buttons?: [string, Action][]) => Promise<void>;
export type SequenceResult =
  | { kind: "handled" }
  | { kind: "finished" }
  | {
      kind: "accepted";
      content: TemplateContent;
      sendAfterSeconds: number;
      destination: MessageDestination;
    };
const handled = { kind: "handled" } as const;
export class AuthorSequenceComposer {
  async begin(
    c: Context,
    destination: MessageDestination,
    lastOffset: number,
    firstEntry: boolean,
    reply: Reply,
  ) {
    c.state.batch = undefined;
    c.state.prompt = undefined;
    if (c.state.funnelAuthor) c.state.funnelAuthor.prompt = undefined;
    c.state.composing = {
      destination,
      prompt: "capture",
      sequence: { lastOffset, firstEntry },
    };
    return this.show(c, reply);
  }
  async show(c: Context, reply: Reply) {
    const s = c.state.composing!,
      sequence = s.sequence!;
    if (!s.content)
      return reply(
        "Пришлите сообщение. Затем выберите время его отправки. Сообщения будут идти в том порядке, в котором вы их добавите. Когда закончите, нажмите «Готово».",
        [["Готово", { kind: "sequence:done" }]],
      );
    const origin =
      s.destination.kind === "broadcast"
        ? "запуска рассылки"
        : "входа человека в воронку";
    return reply(
      sequence.firstEntry
        ? "Первое сообщение воронки приходит сразу при входе. Подтвердите добавление."
        : `Когда отправить это сообщение? Время отсчитывается от ${origin}.\nНапишите «сразу», «1 час», «2 часа» или другое время.${sequence.lastOffset ? ` Не раньше ${formatFunnelDelay(sequence.lastOffset)} — сохраняем порядок сообщений.` : ""}`,
      [
        ...[0, 3600, 7200]
          .filter(
            (n) =>
              n >= sequence.lastOffset && (!sequence.firstEntry || n === 0),
          )
          .map((n): [string, Action] => [
            n ? `Через ${formatFunnelDelay(n)}` : "Сразу",
            { kind: "sequence:time", value: String(n) },
          ]),
        ["Не добавлять это сообщение", { kind: "sequence:discard" }],
      ],
    );
  }
  async answer(c: Context, reply: Reply): Promise<SequenceResult> {
    const s = c.state.composing!;
    if (s.content) {
      const text = c.input.text
        .trim()
        .toLowerCase()
        .replace(/^через\s+/, "");
      const offset = text === "сразу" ? 0 : parseFunnelDelay(text);
      return this.time(c, offset, reply);
    }
    try {
      validateContent(c.input.content);
    } catch {
      await reply(
        "Пришлите отдельное сообщение: текст, фото, видео, кружок, голосовое или документ. Альбомы не поддерживаются.",
        [["Готово", { kind: "sequence:done" }]],
      );
      return handled;
    }
    s.content = structuredClone(c.input.content);
    s.prompt = undefined;
    await this.show(c, reply);
    return handled;
  }
  async act(c: Context, a: Action, reply: Reply): Promise<SequenceResult> {
    if (a.kind === "sequence:time") return this.time(c, Number(a.value), reply);
    const s = c.state.composing!;
    if (a.kind === "sequence:discard") {
      s.content = undefined;
      s.prompt = "capture";
      await this.show(c, reply);
      return handled;
    }
    if (s.content) {
      await this.show(c, reply);
      return handled;
    }
    return { kind: "finished" };
  }
  private async time(
    c: Context,
    offset: number | undefined,
    reply: Reply,
  ): Promise<SequenceResult> {
    const s = c.state.composing!,
      sequence = s.sequence!;
    if (
      !s.content ||
      offset === undefined ||
      !Number.isSafeInteger(offset) ||
      offset < sequence.lastOffset ||
      offset > 2147483647 ||
      (sequence.firstEntry && offset !== 0)
    ) {
      await this.show(c, reply);
      return handled;
    }
    return {
      kind: "accepted",
      content: s.content,
      sendAfterSeconds: offset,
      destination: s.destination,
    };
  }
}
