import { unhandled } from "../../shared/unhandled.js";
import {
  appendAuthorButton,
  nextAuthorButtonRow,
  validateAuthorButtonUrl,
} from "./author-button.js";
import {
  actComposer,
  answerComposer,
  beginComposer,
  chooseLibraryPost,
  isComposerStep,
  openLibrary,
  resumeComposer,
  showLibrary,
  type ComposerResult,
} from "./author-composer.js";
import {
  resolveAuthorCallback,
  type AuthorAction,
  type AuthorBroadcast,
  type AuthorButton,
  type AuthorState,
  type ComposerState,
  type MessageDestination,
} from "./author-dialog.js";
import {
  answerFunnel,
  answerFunnelQuery,
  appendPrepared,
  appendTimed,
  applyFunnelSave,
  composeInFunnel,
  formatFunnelDelay,
  isFunnelEditorAction,
  newFunnel,
  performFunnel,
  rejectFunnelSave,
  selectedParts,
  showFunnel,
} from "./author-funnels.js";
import { messageLabel } from "./author-message-view.js";
import {
  actSequence,
  answerSequence,
  beginSequence as beginSequenceComposer,
  showSequence,
  type SequenceResult,
} from "./author-sequence-composer.js";
import {
  HOME,
  Turn,
  type AfterFunnelSave,
  type AfterSave,
  type AuthorEvent,
  type DialogEnvironment,
  type Transition,
} from "./author-turn.js";
import {
  CommunicationsError,
  validateContent,
  type TemplateContent,
} from "./communications-contract.js";
import type { BroadcastPart, MessagePart } from "./funnel-types.js";

const broadcastNames = {
  draft: "Черновик",
  scheduled: "Запланирована",
  running: "Отправляется",
  paused: "Приостановлена",
  cancelled: "Отменена",
  completed: "Завершена",
};

type BroadcastAction = Extract<
  AuthorAction,
  {
    kind:
      | "broadcast-sample"
      | "parts"
      | "show-part"
      | "replace-part"
      | "move-part"
      | "remove-part"
      | "statistics"
      | "confirm-launch"
      | "confirm-cancel"
      | "launch"
      | "pause"
      | "resume"
      | "cancel";
  }
>;
type CompositionEntry = Extract<
  AuthorAction,
  {
    kind:
      | "compose:broadcast"
      | "compose:funnel"
      | "compose:edit-broadcast"
      | "compose:edit-funnel"
      | "pick-part"
      | "f:posts";
  }
>;

/**
 * Moves the author admin dialog by one event. The function reads nothing but its arguments and
 * changes nothing outside the returned state: saving, sending and every read of the database
 * or Platform are effects that `AuthorAdmin` executes, answering queries with further events.
 */
export function transition(
  state: AuthorState,
  event: AuthorEvent,
  env: DialogEnvironment,
): Transition {
  const t = new Turn(structuredClone(state), env);
  step(t, event);
  return { state: t.state, effects: t.effects };
}

function step(t: Turn, event: AuthorEvent): void {
  switch (event.kind) {
    case "open":
      return welcome(t);
    case "close":
      return close(t);
    case "callback": {
      const action = resolveAuthorCallback(t.state, event.data);
      if (action) return perform(t, action);
      const pending = t.state.composing;
      if (!pending) t.reset();
      return t.reply(
        "Это меню уже устарело. Незавершённое сообщение сохранено, если вы начали его создание.",
        pending ? t.compositionButtons(pending.destination.id) : HOME,
      );
    }
    case "text":
      return answer(t, event);
    case "failed":
      t.reset();
      return t.reply(
        event.during === "callback"
          ? "Пост, рассылка или воронка изменились либо действие недоступно. Откройте актуальную версию."
          : "Данные изменились. Откройте актуальный пост, рассылку или воронку и повторите правку.",
        HOME,
      );
    case "statistics-read": {
      const d = event.deliveries;
      if (event.broadcastId === undefined) {
        if (!d) throw new CommunicationsError("malformed");
        return t.reply(
          `Статистика сообщений\nОтправлено: ${d.sent}\nОжидает: ${d.pending}\nПропущено: ${d.suppressed}\nОшибки: ${d.failed}\nНеизвестный результат: ${d.unknown}`,
          HOME,
        );
      }
      if (!d) return;
      return t.reply(
        `Результаты рассылки\nОтправлено: ${d.sent}\nОжидает: ${d.pending}\nПропущено: ${d.suppressed}\nОшибки: ${d.failed}\nНеизвестный результат: ${d.unknown}\nЧастично отменено: ${d.partialCancelled}\nОбновите статус, чтобы увидеть новые результаты.`,
        [["К рассылке", { kind: "read-broadcast", id: event.broadcastId }]],
      );
    }
    case "posts-listed":
      if (event.purpose === "library") return showLibrary(t, event);
      t.state.prompt = undefined;
      return t.reply(
        t.state.libraryQuery
          ? `Поиск: ${t.state.libraryQuery}`
          : "Сохранённые посты",
        [
          ...event.templates.map((p): AuthorButton => [
            messageLabel(p.content),
            { kind: "read-post", id: p.templateId },
          ]),
          ...(event.nextCursor
            ? [
                [
                  "Следующие",
                  { kind: "posts", id: event.nextCursor },
                ] as AuthorButton,
              ]
            : []),
          ["Найти пост", { kind: "post-search" }],
          ["Все посты", { kind: "posts-all" }],
          ["Все рассылки", { kind: "broadcasts" }],
        ],
      );
    case "post-read":
      if (event.purpose === "library")
        return chooseLibraryPost(t, event.template);
      t.state.template = event.template;
      return showPost(t);
    case "post-saved":
      t.state.template = event.template;
      return showPost(t);
    case "post-conflict":
      t.reset();
      return t.reply("Пост уже изменился. Откройте его заново.", HOME);
    case "broadcast-saved":
      if (event.broadcast) t.state.broadcast = event.broadcast;
      t.retainBroadcast();
      return afterBroadcastSave(t, event.then);
    case "broadcast-changed":
      if (event.broadcast) t.state.broadcast = event.broadcast;
      return broadcastCard(t);
    case "broadcasts-listed":
      return t.reply("Рассылки", [
        ["Создать рассылку", { kind: "new-broadcast" }],
        ["Сохранённые посты", { kind: "posts-all" }],
        ...event.items.map(({ broadcast, name }): AuthorButton => [
          `${name.slice(0, 35)} · ${broadcastNames[broadcast.state]}`,
          { kind: "read-broadcast", id: broadcast.broadcastId },
        ]),
        ...(event.nextCursor
          ? [
              [
                "Следующие",
                { kind: "broadcasts", id: event.nextCursor },
              ] as AuthorButton,
            ]
          : []),
        ["В меню", { kind: "home" }],
      ]);
    case "broadcast-read":
      t.state.broadcast = event.broadcast;
      t.state.broadcastName = event.name;
      return broadcastCard(t);
    case "composition-restored":
      restoreComposition(t, event.composing);
      if (event.then === "resume")
        return event.composing.sequence ? showSequence(t) : resumeComposer(t);
      if (event.composing.sequence)
        return sequenceResult(t, { kind: "finished" });
      return composeResult(t, actComposer(t, { kind: "compose:cancel" }));
    case "funnel-saved":
      applyFunnelSave(t, event.funnel);
      return afterFunnelSave(t, event.then);
    case "funnel-invalid":
      if (event.then.kind === "next-message")
        throw new CommunicationsError("malformed");
      return rejectFunnelSave(t);
    case "funnels-listed":
    case "funnel-read":
    case "intro-read":
    case "content-validated":
    case "intro-saved":
    case "funnel-locked":
    case "funnel-published":
    case "publication-previewed":
    case "funnel-changed":
    case "part-history-read":
      return answerFunnelQuery(t, event);
    default:
      return unhandled(event, "author event");
  }
}

function close(t: Turn) {
  const s = t.state;
  if (s.batch) {
    const kind = s.batch;
    s.batch = undefined;
    if (kind === "broadcast") return broadcastCard(t);
    return performFunnel(t, { kind: "f:show" });
  }
  if (s.composing?.sequence) return sequenceResult(t, { kind: "finished" });
  if (s.composing)
    return composeResult(t, actComposer(t, { kind: "compose:cancel" }));
  welcome(t);
}

function welcome(t: Turn) {
  t.reset();
  t.reply(
    "Админка коммуникаций. Текст и медиа готовьте здесь, в Telegram.",
    HOME,
  );
}

function perform(t: Turn, a: AuthorAction): void {
  if (isComposerStep(a)) return composeResult(t, actComposer(t, a));
  if (isFunnelEditorAction(a)) return performFunnel(t, a);
  const s = t.state;
  const template = s.template;
  const b = s.broadcast;
  // A button whose post or broadcast is no longer selected.
  const unavailable = () =>
    b
      ? t.reply("Откройте меню заново.", HOME)
      : t.reply("Выберите пост, рассылку или воронку.", HOME);
  switch (a.kind) {
    case "sequence:broadcast":
      return beginSequence(t, "broadcast");
    case "sequence:funnel":
      return beginSequence(t, "funnel");
    case "sequence:discard":
    case "sequence:done":
    case "sequence:time":
      return sequenceResult(t, actSequence(t, a));
    case "menu:page":
      return t.renderMenu(Number(a.value));
    case "batch:broadcast":
      return beginBatch(t, "broadcast");
    case "batch:funnel":
      return beginBatch(t, "funnel");
    case "batch:done": {
      const kind = s.batch;
      s.batch = undefined;
      if (kind === "funnel") return performFunnel(t, { kind: "f:save" });
      return broadcastCard(t);
    }
    case "compose:broadcast":
    case "compose:funnel":
    case "compose:edit-broadcast":
    case "compose:edit-funnel":
    case "pick-part":
    case "f:posts":
      return beginComposition(t, a);
    case "compose:resume":
      return t.ask({
        kind: "restore-composition",
        destinationId: a.id,
        then: "resume",
      });
    case "compose:discard":
      return t.ask({
        kind: "restore-composition",
        destinationId: a.id,
        then: "discard",
      });
    case "new-broadcast":
      s.broadcast = newBroadcast(t);
      s.broadcastName = undefined;
      t.retainBroadcast();
      return beginSequence(t, "broadcast");
    case "overview":
      return t.ask({ kind: "read-statistics" });
    case "f:new":
      newFunnel(t);
      return beginSequence(t, "funnel");
    case "home":
      s.batch = undefined;
      t.retainFunnelDraft();
      t.reset();
      return t.reply("Админка коммуникаций", HOME);
    case "replace":
      if (!template) return t.reply("Выберите пост.", HOME);
      s.prompt = { kind: "replace" };
      return t.reply(
        "Пришлите одно сообщение: текст, фото, видео, кружок, голосовое или документ. Используйте форматирование Telegram. Альбомы и опросы пока не поддерживаются. /cancel — выйти.",
      );
    case "posts":
      return t.ask({
        kind: "list-posts",
        purpose: "posts",
        cursor: a.id,
        search: s.libraryQuery,
      });
    case "posts-all":
      s.libraryQuery = undefined;
      return t.ask({ kind: "list-posts", purpose: "posts" });
    case "post-search":
      s.prompt = { kind: "post-search" };
      return t.reply("Напишите часть текста или тип сообщения.", []);
    case "read-post":
      return t.ask({ kind: "read-post", purpose: "post", templateId: a.id });
    case "sample":
      if (!template) return unavailable();
      t.emit({
        kind: "test-send",
        templateId: template.templateId,
        revision: template.revision,
      });
      return t.reply(
        "Образец поставлен в очередь только вам. При неизвестном результате отправки автоматического повтора не будет.",
        [["Вернуться к посту", { kind: "read-post", id: template.templateId }]],
      );
    case "button":
      if (!template) return unavailable();
      s.prompt = { kind: "button-title" };
      return t.reply("Напишите название кнопки (до 64 символов).");
    case "remove-button":
      if (!template) return unavailable();
      return t.ask({
        kind: "save-post",
        templateId: template.templateId,
        content: {
          ...template.content,
          buttons: template.content.buttons.filter(
            (_, i) => i !== Number(a.value),
          ),
        },
        revision: template.revision,
        reportConflict: false,
      });
    case "create-broadcast":
      if (!template) return unavailable();
      s.broadcast = newBroadcast(t, [{ content: template.content }]);
      s.broadcastName = template.content.text.slice(0, 128) || "Рассылка";
      return saveBroadcast(t, { kind: "card" });
    case "broadcasts":
      s.batch = undefined;
      s.composing = undefined;
      s.prompt = undefined;
      return t.ask({ kind: "list-broadcasts", cursor: a.id });
    case "read-broadcast":
      s.composing = undefined;
      return t.ask({ kind: "read-broadcast", broadcastId: a.id });
    case "broadcast-sample":
    case "parts":
    case "show-part":
    case "replace-part":
    case "move-part":
    case "remove-part":
    case "statistics":
    case "confirm-launch":
    case "confirm-cancel":
    case "launch":
    case "pause":
    case "resume":
    case "cancel":
      if (!b) return unavailable();
      return performOnBroadcast(t, a, b);
    default:
      return unhandled(a, "author action");
  }
}

/** Actions on the selected broadcast. */
function performOnBroadcast(
  t: Turn,
  a: BroadcastAction,
  b: AuthorBroadcast,
): void {
  switch (a.kind) {
    case "broadcast-sample":
      for (const part of b.parts)
        t.emit({ kind: "message", content: part.content });
      t.state.freshMenu = true;
      return broadcastCard(t);
    case "parts": {
      t.state.replacePart = undefined;
      const offset = Number(a.value ?? 0);
      return t.reply(
        "Сообщения отправятся по порядку. Выберите сообщение, чтобы изменить его или порядок отправки.",
        [
          ...b.parts
            .slice(offset, offset + 5)
            .map((part, index): AuthorButton => [
              `${offset + index + 1}. ${partTime(part)} · ${messageLabel(part.content, 32)}`,
              { kind: "show-part", id: part.partId },
            ]),
          ...(offset > 0
            ? [
                [
                  "Предыдущие",
                  { kind: "parts", value: String(offset - 5) },
                ] as AuthorButton,
              ]
            : []),
          ...(b.parts.length > offset + 5
            ? [
                [
                  "Следующие",
                  { kind: "parts", value: String(offset + 5) },
                ] as AuthorButton,
              ]
            : []),
          ...(b.parts.length < 20
            ? ([
                ["Создать сообщение", { kind: "compose:broadcast" }],
                ["Добавить сохранённый пост", { kind: "pick-part" }],
                ["Добавить сообщения", { kind: "batch:broadcast" }],
              ] as AuthorButton[])
            : []),
          ["К рассылке", { kind: "read-broadcast", id: b.broadcastId }],
        ],
      );
    }
    case "show-part": {
      const index = b.parts.findIndex((p) => p.partId === a.id);
      const part = b.parts[index];
      if (!part) throw new CommunicationsError("not_found");
      t.preview(part.content);
      return t.reply(messageLabel(part.content, 300), [
        [
          "Изменить сообщение и кнопки",
          { kind: "compose:edit-broadcast", id: part.partId },
        ],
        [
          "Заменить из сохранённых",
          { kind: "replace-part", value: String(index) },
        ],
        ...(index > 0
          ? [
              [
                "Поднять выше",
                { kind: "move-part", value: String(index) },
              ] as AuthorButton,
            ]
          : []),
        ...(b.parts.length > 1
          ? [
              [
                "Удалить сообщение",
                { kind: "remove-part", value: String(index) },
              ] as AuthorButton,
            ]
          : []),
        ["Все сообщения", { kind: "parts" }],
      ]);
    }
    case "replace-part": {
      const part = b.parts[Number(a.value)];
      if (!part) throw new CommunicationsError("revision_conflict");
      t.state.replacePart = {
        broadcastId: b.broadcastId,
        partId: part.partId,
      };
      return perform(t, { kind: "pick-part" });
    }
    case "move-part": {
      const index = Number(a.value);
      const part = b.parts[index];
      const before = b.parts[index - 1];
      // Send times must not decrease, so they stay in place and the messages move between them.
      if (part && before) {
        b.parts[index] = withTime(before, part.sendAfterSeconds);
        b.parts[index - 1] = withTime(part, before.sendAfterSeconds);
      }
      return saveBroadcast(t, { kind: "card" });
    }
    case "remove-part":
      if (b.parts.length > 1)
        b.parts = b.parts.filter((_, index) => index !== Number(a.value));
      return saveBroadcast(t, { kind: "card" });
    case "statistics":
      return t.ask({ kind: "read-statistics", broadcastId: b.broadcastId });
    case "confirm-launch":
    case "confirm-cancel":
      if (a.kind === "confirm-launch" && b.audience.kind !== "all") {
        b.audience = { kind: "all" };
        return saveBroadcast(t, { kind: "confirm-launch" });
      }
      return t.reply(
        a.kind === "confirm-launch"
          ? `Запустить «${t.state.broadcastName ?? "Рассылка"}»?\n${b.parts.length} сообщений, версия ${b.revision}.\nКому: ${b.audience.kind === "all" ? "все доступные контакты" : `выбранные воронки: ${b.audience.funnelIds.length}, без дублей`}.\nКогда: ${b.scheduledAt ? moscowTime(b.scheduledAt) : "сразу после подтверждения"}.`
          : "Отменить рассылку? Уже отправленные сообщения останутся у получателей.",
        [
          [
            a.kind === "confirm-launch" ? "Запустить рассылку" : "Да, отменить",
            { kind: a.kind === "confirm-launch" ? "launch" : "cancel" },
          ],
          ["Назад", { kind: "read-broadcast", id: b.broadcastId }],
        ],
      );
    case "launch":
    case "pause":
    case "resume":
    case "cancel":
      if (b.revision === 0) {
        if (a.kind === "cancel") {
          b.state = "cancelled";
          t.retainBroadcast();
          return broadcastCard(t);
        }
        return t.reply("Добавьте хотя бы одно сообщение перед запуском.", [
          ["К рассылке", { kind: "read-broadcast", id: b.broadcastId }],
        ]);
      }
      return t.ask({
        kind: "change-broadcast",
        broadcastId: b.broadcastId,
        revision: b.revision,
        operation: a.kind,
      });
    default:
      return unhandled(a, "broadcast action");
  }
}

function selectedBroadcast(t: Turn): AuthorBroadcast {
  const b = t.state.broadcast;
  if (!b) throw new CommunicationsError("not_found");
  return b;
}

function selectedFunnel(t: Turn) {
  const f = t.state.funnelAuthor?.funnel;
  if (!f) throw new CommunicationsError("not_found");
  return f;
}

function newBroadcast(
  t: Turn,
  parts: readonly Omit<BroadcastPart, "partId">[] = [],
): AuthorBroadcast {
  return {
    broadcastId: t.newId(),
    revision: 0,
    state: "draft",
    parts: parts.map((p) => ({ ...p, partId: t.newId() })),
    audience: { kind: "all" },
    scheduledAt: null,
    audienceSnapshotId: null,
    snapshotSize: 0,
  };
}

/** `broadcasts.save` accepts a broadcast's messages only until launch takes its audience. */
function editable(b: AuthorBroadcast): boolean {
  return (
    !b.audienceSnapshotId && ["draft", "scheduled", "paused"].includes(b.state)
  );
}

function partTime(part: BroadcastPart): string {
  return part.sendAfterSeconds
    ? `Через ${formatFunnelDelay(part.sendAfterSeconds)}`
    : "Сразу";
}

/** Adds a message at the end, sent together with the last one so send times never decrease. */
function appendPart(t: Turn, b: AuthorBroadcast, content: TemplateContent) {
  b.parts.push(
    withTime({ partId: t.newId(), content }, b.parts.at(-1)?.sendAfterSeconds),
  );
}

function withTime(
  { partId, content }: MessagePart,
  sendAfterSeconds: number | undefined,
): BroadcastPart {
  return sendAfterSeconds === undefined
    ? { partId, content }
    : { partId, content, sendAfterSeconds };
}

function showPost(t: Turn) {
  const template = t.state.template;
  if (!template) throw new CommunicationsError("not_found");
  t.state.prompt = undefined;
  t.reply(
    `Пост · версия ${template.revision}\n${template.content.type} · ${template.content.buttons.length} кнопок\n${template.content.text.slice(0, 500) || "Медиа без подписи"}`,
    [
      ["Образец себе", { kind: "sample" }],
      ["Заменить сообщение", { kind: "replace" }],
      ["Добавить кнопку", { kind: "button" }],
      ["Создать рассылку", { kind: "create-broadcast" }],
      // Removing a button is rarer than the actions above, so a long menu pages it away.
      ...template.content.buttons.map((b, i): AuthorButton => [
        `Удалить: ${b.text}`,
        { kind: "remove-button", value: String(i) },
      ]),
      ["К постам", { kind: "posts" }],
    ],
  );
}

function batchMenu(t: Turn) {
  const count =
    t.state.batch === "broadcast"
      ? selectedBroadcast(t).parts.length
      : selectedFunnel(t).entryResponse.parts.length;
  t.reply(
    count
      ? `Сохранено сообщений: ${count}.\nПришлите ещё или нажмите «Готово».`
      : `Подготовка сообщений\nПришлите несколько сообщений подряд: текст, фото, видео, кружки, голосовые или документы. Каждый отдельный пост сохраняется сразу в черновик. Когда закончите, нажмите «Готово».`,
    [
      ["Готово", { kind: "batch:done" }],
      ["Назад", { kind: "batch:done" }],
    ],
  );
}

function beginBatch(t: Turn, kind: "broadcast" | "funnel") {
  const id =
    kind === "broadcast"
      ? selectedBroadcast(t).broadcastId
      : selectedFunnel(t).funnelId;
  const pending = t.compositionButtons(id);
  if (pending.length)
    return t.reply(
      "Сначала завершите или отмените незавершённую правку сообщения.",
      pending,
    );
  if (kind === "broadcast") {
    if (!editable(selectedBroadcast(t)))
      throw new CommunicationsError("revision_conflict");
  } else if (selectedFunnel(t).lifecycle === "archived")
    throw new CommunicationsError("revision_conflict");
  t.state.batch = kind;
  t.state.composing = undefined;
  t.state.prompt = undefined;
  if (t.state.funnelAuthor) t.state.funnelAuthor.prompt = undefined;
  batchMenu(t);
}

function broadcastCard(t: Turn) {
  t.state.replacePart = undefined;
  t.state.prompt = undefined;
  const b = selectedBroadcast(t);
  const pending =
    b.state === "draft" ? t.compositionButtons(b.broadcastId) : [];
  t.reply(
    `${t.state.broadcastName ?? "Рассылка"}\n${broadcastNames[b.state]} · сообщений: ${b.parts.length}\n${b.parts
      .slice(0, 5)
      .map(
        (p, i) => `${i + 1}. ${partTime(p)} · ${messageLabel(p.content, 35)}`,
      )
      .join(
        "\n",
      )}${b.parts.length > 5 ? `\nЕщё сообщений: ${b.parts.length - 5}` : ""}\nКому: всем доступным подписчикам.${b.state === "draft" ? " Время сообщений отсчитывается от запуска." : ""}`,
    [
      ...pending,
      ...(b.state === "draft" && !pending.length
        ? [
            [
              "Добавить сообщение",
              { kind: "sequence:broadcast" },
            ] as AuthorButton,
          ]
        : []),
      ...(b.state === "draft" && b.parts.length && !pending.length
        ? [["Запустить", { kind: "confirm-launch" }] as AuthorButton]
        : []),
      ...(["scheduled", "running"].includes(b.state)
        ? [["Приостановить", { kind: "pause" }] as AuthorButton]
        : []),
      ...(b.state === "paused"
        ? [["Продолжить", { kind: "resume" }] as AuthorButton]
        : []),
      ...(!["completed", "cancelled"].includes(b.state)
        ? [["Отменить рассылку", { kind: "confirm-cancel" }] as AuthorButton]
        : []),
      ...(b.parts.length
        ? [
            [
              "Посмотреть сообщения",
              { kind: "broadcast-sample" },
            ] as AuthorButton,
          ]
        : []),
      ...(editable(b)
        ? [["Сообщения", { kind: "parts" }] as AuthorButton]
        : []),
      ...(["running", "paused", "completed", "cancelled"].includes(b.state) &&
      b.revision
        ? [["Результаты отправки", { kind: "statistics" }] as AuthorButton]
        : []),
      ["Все рассылки", { kind: "broadcasts" }],
    ],
  );
}

function beginSequence(t: Turn, kind: "broadcast" | "funnel"): void {
  const id =
    kind === "broadcast"
      ? selectedBroadcast(t).broadcastId
      : selectedFunnel(t).funnelId;
  const pending = t.compositionButtons(id);
  if (pending.length)
    return t.reply(
      "Есть незавершённое сообщение. Продолжите его или отмените добавление.",
      pending,
    );
  if (kind === "broadcast") {
    const b = selectedBroadcast(t);
    if (b.state !== "draft" || b.audienceSnapshotId)
      throw new CommunicationsError("revision_conflict");
    if (b.parts.length >= 20) return broadcastCard(t);
    return beginSequenceComposer(
      t,
      { kind: "broadcast", id, expectedRevision: b.revision },
      b.parts.at(-1)?.sendAfterSeconds ?? 0,
      false,
    );
  }
  const f = selectedFunnel(t);
  if (
    f.lifecycle === "archived" ||
    f.entryResponse.parts.length +
      f.steps.reduce((n, s) => n + s.parts.length, 0) >=
      100
  )
    return performFunnel(t, { kind: "f:show" });
  const offset = f.steps.reduce(
    (n, step) =>
      step.delayAnchor === "entry" ? step.delaySeconds : n + step.delaySeconds,
    0,
  );
  beginSequenceComposer(
    t,
    { kind: "funnel", id, target: "entry", expectedRevision: f.revision },
    offset,
    f.entryResponse.parts.length === 0,
  );
}

function sequenceResult(t: Turn, result: SequenceResult): void {
  if (result.kind === "handled") return;
  const composing = t.state.composing;
  if (!composing) throw new CommunicationsError("not_found");
  const destination = composing.destination;
  if (result.kind === "accepted") {
    const then = {
      kind: "next-message",
      destinationId: destination.id,
    } as const;
    if (destination.kind === "broadcast") {
      const b = selectedBroadcast(t);
      if (
        b.revision !== destination.expectedRevision ||
        b.state !== "draft" ||
        b.parts.length >= 20
      )
        throw new CommunicationsError("revision_conflict");
      if (!b.parts.length && !t.state.broadcastName)
        t.state.broadcastName =
          result.content.text.slice(0, 80) || messageLabel(result.content);
      b.parts.push({
        partId: t.newId(),
        content: result.content,
        sendAfterSeconds: result.sendAfterSeconds,
      });
      return saveBroadcast(t, then);
    }
    if (selectedFunnel(t).revision !== destination.expectedRevision)
      throw new CommunicationsError("revision_conflict");
    appendTimed(t, result.content, result.sendAfterSeconds);
    return t.ask({ kind: "save-funnel", funnel: selectedFunnel(t), then });
  }
  t.discardComposition(destination.id);
  t.state.composing = undefined;
  if (destination.kind === "broadcast") return broadcastCard(t);
  performFunnel(t, { kind: "f:show" });
}

/** Saves the selected broadcast; an empty unsaved one stays only a local draft. */
function saveBroadcast(t: Turn, then: AfterSave) {
  const b = selectedBroadcast(t);
  if (!b.parts.length && b.revision === 0) {
    t.retainBroadcast();
    return afterBroadcastSave(t, then);
  }
  t.ask({ kind: "save-broadcast", broadcast: b, then });
}

function afterBroadcastSave(t: Turn, then: AfterSave): void {
  switch (then.kind) {
    case "card":
      return broadcastCard(t);
    case "confirm-launch":
      return perform(t, { kind: "confirm-launch" });
    case "batch":
      return batchMenu(t);
    case "next-message":
      return nextMessage(t, then.destinationId, "broadcast");
    default:
      return unhandled(then, "broadcast continuation");
  }
}

/** The sequence message is saved: drop its pending copy and ask for the next one. */
function nextMessage(
  t: Turn,
  destinationId: string,
  kind: "broadcast" | "funnel",
) {
  t.discardComposition(destinationId);
  t.state.composing = undefined;
  beginSequence(t, kind);
}

function afterFunnelSave(t: Turn, then: AfterFunnelSave): void {
  switch (then.kind) {
    case "card":
      return showFunnel(t);
    case "next-message":
      return nextMessage(t, then.destinationId, "funnel");
    default:
      return unhandled(then, "funnel continuation");
  }
}

/** Starts a message for a broadcast or funnel, from scratch, a saved post or an existing part. */
function beginComposition(t: Turn, a: CompositionEntry): void {
  let destination: MessageDestination;
  if (
    a.kind === "compose:funnel" ||
    a.kind === "compose:edit-funnel" ||
    a.kind === "f:posts"
  ) {
    const f = t.state.funnelAuthor;
    const block =
      f?.target === "intro"
        ? f.intro && { id: f.intro.introId, revision: f.intro.revision }
        : f?.funnel && { id: f.funnel.funnelId, revision: f.funnel.revision };
    if (!block || !f?.target) throw new CommunicationsError("not_found");
    destination = {
      kind: "funnel",
      id: block.id,
      expectedRevision: block.revision,
      target: f.target,
      partId:
        a.kind === "compose:edit-funnel"
          ? a.id
          : a.kind === "f:posts"
            ? a.value
            : undefined,
    };
  } else {
    const b = t.state.broadcast;
    if (!b) throw new CommunicationsError("not_found");
    destination = {
      kind: "broadcast",
      id: b.broadcastId,
      expectedRevision: b.revision,
      partId:
        a.kind === "compose:edit-broadcast"
          ? a.id
          : t.state.replacePart?.partId,
    };
  }
  const pending = t.compositionButtons(destination.id);
  if (pending.length)
    return t.reply(
      "Для этого объекта уже есть незавершённое сообщение. Продолжите его или явно отмените добавление.",
      pending,
    );
  if (a.kind === "pick-part" || a.kind === "f:posts") {
    t.state.composing = { destination };
    return openLibrary(t);
  }
  const content =
    a.kind === "compose:edit-broadcast"
      ? t.state.broadcast?.parts.find((p) => p.partId === a.id)?.content
      : a.kind === "compose:edit-funnel"
        ? selectedParts(t).find((p) => p.partId === a.id)?.content
        : undefined;
  beginComposer(t, destination, content);
}

function composeResult(t: Turn, result: ComposerResult): void {
  if (result.kind === "handled") return;
  const d = result.destination;
  t.discardComposition(d.id);
  if (d.kind === "broadcast") {
    const b = t.state.broadcast;
    if (!b || b.broadcastId !== d.id)
      throw new CommunicationsError("revision_conflict");
    if (result.kind === "accepted") {
      if (b.revision !== d.expectedRevision || !editable(b))
        throw new CommunicationsError("revision_conflict");
      if (d.partId) {
        if (!b.parts.some((p) => p.partId === d.partId))
          throw new CommunicationsError("revision_conflict");
        b.parts = b.parts.map((p) =>
          p.partId === d.partId ? { ...p, content: result.content } : p,
        );
      } else {
        if (b.parts.length >= 20)
          throw new CommunicationsError("unsupported_content");
        appendPart(t, b, result.content);
      }
      t.state.composing = undefined;
      return saveBroadcast(t, { kind: "card" });
    }
    broadcastCard(t);
  } else
    composeInFunnel(
      t,
      d,
      result.kind === "accepted" ? result.content : undefined,
    );
  t.state.composing = undefined;
}

/** Continues a saved unfinished message, if it still belongs to the open broadcast or funnel. */
function restoreComposition(t: Turn, composer: ComposerState) {
  const d = composer.destination;
  if (d.kind === "broadcast") {
    if (t.state.broadcast?.broadcastId !== d.id)
      throw new CommunicationsError("not_found");
  } else {
    const f = t.state.funnelAuthor;
    if (
      !f ||
      (d.target === "intro" ? f.intro?.introId : f.funnel?.funnelId) !== d.id
    )
      throw new CommunicationsError("not_found");
    f.target = d.target;
    f.prompt = undefined;
  }
  t.state.prompt = undefined;
  t.state.composing = composer;
}

function answer(t: Turn, input: { text: string; content: unknown }): void {
  const s = t.state;
  if (s.composing?.sequence) return sequenceResult(t, answerSequence(t, input));
  if (s.batch) {
    const content = input.content;
    try {
      validateContent(content);
    } catch {
      return t.reply(
        "Не удалось принять сообщение. Пришлите отдельный текст, фото, видео, кружок, голосовое или документ. Принятые сообщения сохранены.",
        [
          ["Продолжить", { kind: `batch:${s.batch}` }],
          ["Готово", { kind: "batch:done" }],
        ],
      );
    }
    if (s.batch === "funnel") {
      appendPrepared(t, structuredClone(content));
      return batchMenu(t);
    }
    const b = selectedBroadcast(t);
    if (b.parts.length >= 20)
      return t.reply("В одной рассылке не больше 20 сообщений.", [
        ["Готово", { kind: "batch:done" }],
      ]);
    if (!b.parts.length && !s.broadcastName)
      s.broadcastName = content.text.slice(0, 80) || messageLabel(content);
    appendPart(t, b, structuredClone(content));
    return saveBroadcast(t, { kind: "batch" });
  }
  if (s.composing) return answerComposer(t, input);
  const text = input.text;
  if (s.prompt?.kind === "post-search") {
    if (!text || text.length > 128)
      return t.reply("Введите от 1 до 128 символов.");
    s.libraryQuery = text;
    return perform(t, { kind: "posts" });
  }
  if (s.funnelAuthor?.prompt) return answerFunnel(t, input);
  const prompt = s.prompt;
  switch (prompt?.kind) {
    case "replace": {
      const content = input.content;
      try {
        validateContent(content);
      } catch {
        return t.reply(
          "Не удалось принять оформление. Пришлите отдельное поддерживаемое сообщение.",
        );
      }
      const template = s.template;
      if (!template) throw new CommunicationsError("not_found");
      return t.ask({
        kind: "save-post",
        templateId: template.templateId,
        content: { ...content, buttons: template.content.buttons },
        revision: template.revision,
        reportConflict: true,
      });
    }
    case "button-title":
      if (!text || text.length > 64)
        return t.reply("Название должно содержать от 1 до 64 символов.");
      s.prompt = { kind: "button-url", buttonTitle: text };
      return t.reply("Пришлите HTTPS-ссылку для кнопки.");
    case "button-url": {
      try {
        validateAuthorButtonUrl(prompt.buttonTitle, text);
      } catch {
        return t.reply(
          "Нужна корректная HTTPS-ссылка без пароля или служебного адреса Telegram.",
        );
      }
      const template = s.template;
      if (!template) throw new CommunicationsError("not_found");
      return t.ask({
        kind: "save-post",
        templateId: template.templateId,
        content: appendAuthorButton(
          template.content,
          prompt.buttonTitle,
          text,
          nextAuthorButtonRow(template.content),
        ),
        revision: template.revision,
        reportConflict: false,
      });
    }
    case "post-search":
    case undefined:
      break;
    default:
      return unhandled(prompt, "author prompt");
  }
  t.reset();
  t.reply("Выберите «Рассылки» или «Воронки», чтобы добавить сообщения.", HOME);
}

function moscowTime(date: string) {
  return `${new Date(date).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })} · Москва`;
}
