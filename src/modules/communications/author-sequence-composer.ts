import { unhandled } from "../../shared/unhandled.js";
import type {
  AuthorButton,
  MessageDestination,
  SequenceAction,
} from "./author-dialog.js";
import { formatFunnelDelay, parseFunnelDelay } from "./author-funnels.js";
import type { Turn } from "./author-turn.js";
import {
  CommunicationsError,
  validateContent,
  type TemplateContent,
} from "./communications-contract.js";

/** Buttons inside a running sequence; the admin starts a sequence itself. */
export type SequenceStep = Extract<
  SequenceAction,
  { kind: "sequence:discard" | "sequence:done" | "sequence:time" }
>;
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

/** Takes one message and its send time at a time, keeping the order the author set. */
export function beginSequence(
  t: Turn,
  destination: MessageDestination,
  lastOffset: number,
  firstEntry: boolean,
) {
  t.state.batch = undefined;
  t.state.prompt = undefined;
  if (t.state.funnelAuthor) t.state.funnelAuthor.prompt = undefined;
  t.state.composing = {
    destination,
    prompt: "capture",
    sequence: { lastOffset, firstEntry },
  };
  showSequence(t);
}

export function showSequence(t: Turn) {
  const { s, sequence } = sequenceState(t);
  if (!s.content)
    return t.reply(
      "Пришлите сообщение. Затем выберите время его отправки. Сообщения будут идти в том порядке, в котором вы их добавите. Когда закончите, нажмите «Готово».",
      [["Готово", { kind: "sequence:done" }]],
    );
  const origin =
    s.destination.kind === "broadcast"
      ? "запуска рассылки"
      : "входа человека в воронку";
  t.reply(
    sequence.firstEntry
      ? "Первое сообщение воронки приходит сразу при входе. Подтвердите добавление."
      : `Когда отправить это сообщение? Время отсчитывается от ${origin}.\nНапишите «сразу», «1 час», «2 часа» или другое время.${sequence.lastOffset ? ` Не раньше ${formatFunnelDelay(sequence.lastOffset)} — сохраняем порядок сообщений.` : ""}`,
    [
      ...[0, 3600, 7200]
        .filter(
          (n) => n >= sequence.lastOffset && (!sequence.firstEntry || n === 0),
        )
        .map((n): AuthorButton => [
          n ? `Через ${formatFunnelDelay(n)}` : "Сразу",
          { kind: "sequence:time", value: String(n) },
        ]),
      ["Не добавлять это сообщение", { kind: "sequence:discard" }],
    ],
  );
}

export function answerSequence(
  t: Turn,
  input: { text: string; content: unknown },
): SequenceResult {
  const { s } = sequenceState(t);
  if (s.content) {
    const text = input.text
      .trim()
      .toLowerCase()
      .replace(/^через\s+/, "");
    return time(t, text === "сразу" ? 0 : parseFunnelDelay(text));
  }
  try {
    validateContent(input.content);
  } catch {
    t.reply(
      "Пришлите отдельное сообщение: текст, фото, видео, кружок, голосовое или документ. Альбомы не поддерживаются.",
      [["Готово", { kind: "sequence:done" }]],
    );
    return handled;
  }
  s.content = structuredClone(input.content);
  s.prompt = undefined;
  showSequence(t);
  return handled;
}

export function actSequence(t: Turn, a: SequenceStep): SequenceResult {
  const { s } = sequenceState(t);
  switch (a.kind) {
    case "sequence:time":
      return time(t, Number(a.value));
    case "sequence:discard":
      s.content = undefined;
      s.prompt = "capture";
      showSequence(t);
      return handled;
    case "sequence:done":
      if (!s.content) return { kind: "finished" };
      showSequence(t);
      return handled;
    default:
      return unhandled(a, "sequence action");
  }
}

function time(t: Turn, offset: number | undefined): SequenceResult {
  const { s, sequence } = sequenceState(t);
  if (
    !s.content ||
    offset === undefined ||
    !Number.isSafeInteger(offset) ||
    offset < sequence.lastOffset ||
    offset > 2147483647 ||
    (sequence.firstEntry && offset !== 0)
  ) {
    showSequence(t);
    return handled;
  }
  return {
    kind: "accepted",
    content: s.content,
    sendAfterSeconds: offset,
    destination: s.destination,
  };
}

function sequenceState(t: Turn) {
  const s = t.state.composing;
  if (!s?.sequence) throw new CommunicationsError("not_found");
  return { s, sequence: s.sequence };
}
