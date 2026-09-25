import { unhandled } from "../../shared/unhandled.js";
import type {
  AuthorAction,
  AuthorButton,
  AuthorFunnelState,
  FunnelAction,
  MessageDestination,
} from "./author-dialog.js";
import { messageLabel } from "./author-message-view.js";
import type { AuthorEvent, Turn } from "./author-turn.js";
import {
  CommunicationsError,
  type TemplateContent,
} from "./communications-contract.js";
import type {
  FunnelSnapshot,
  FunnelStep,
  MessagePart,
} from "./funnel-types.js";

type Buttons = AuthorButton[];
const MAX_DELAY = 2147483647;
const back: Buttons = [["К воронке", { kind: "f:show" }]];
const root: Buttons = [
  ["Все воронки", { kind: "f:list" }],
  ["В меню", { kind: "home" }],
];
const names = {
  draft: "Черновик",
  published: "Опубликована",
  paused: "Приостановлена",
  archived: "В архиве",
};

/** Funnel buttons that start a composition; the funnel editor handles the rest. */
const FUNNEL_ENTRIES = ["f:new", "f:posts"] as const;
export type FunnelEditorAction = Exclude<
  FunnelAction,
  { kind: (typeof FUNNEL_ENTRIES)[number] }
>;
export function isFunnelEditorAction(
  action: AuthorAction,
): action is FunnelEditorAction {
  return (
    action.kind.startsWith("f:") &&
    !(FUNNEL_ENTRIES as readonly string[]).includes(action.kind)
  );
}
/** Funnel buttons that do not leave the current prompt. */
type PromptStep = Extract<
  FunnelEditorAction,
  {
    kind:
      "f:settings" | "f:messages" | "f:message" | "f:timing" | "f:timing-entry";
  }
>;
/** Funnel buttons that need an open funnel. */
type FunnelEdit = Exclude<
  FunnelEditorAction,
  | PromptStep
  | {
      kind:
        | "f:discard"
        | "f:list"
        | "f:read"
        | "f:show"
        | "f:intro"
        | "f:parts"
        | "f:parts-page"
        | "f:part"
        | "f:move-part"
        | "f:remove-part"
        | "f:sample";
    }
>;

// Funnel composition shares the admin's session, authorization, update receipt and reply outbox.

function funnelState(t: Turn): AuthorFunnelState {
  return (t.state.funnelAuthor ??= {});
}

function openFunnel(s: AuthorFunnelState): FunnelSnapshot {
  if (!s.funnel) throw new CommunicationsError("not_found");
  return s.funnel;
}

/** Starts a new funnel; the admin then asks for its first message. */
export function newFunnel(t: Turn) {
  leavePrompts(t);
  t.retainFunnelDraft();
  t.state.funnelAuthor = {
    funnel: {
      funnelId: t.newId(),
      name: "Новая воронка",
      isDefault: false,
      entryResponse: { stepId: t.newId(), parts: [] },
      steps: [],
      sources: [],
      revision: 0,
      publishedRevision: null,
      lifecycle: "draft",
    },
    dirty: true,
    prompt: "name",
  };
}

export function appendPrepared(t: Turn, content: TemplateContent) {
  const s = funnelState(t);
  const f = openFunnel(s);
  if (f.lifecycle === "archived")
    throw new CommunicationsError("revision_conflict");
  if (f.entryResponse.parts.length >= 100)
    throw new CommunicationsError("unsupported_content");
  s.funnel = {
    ...f,
    name:
      !f.entryResponse.parts.length && f.name === "Новая воронка"
        ? content.text.slice(0, 80) || messageLabel(content)
        : f.name,
    entryResponse: {
      ...f.entryResponse,
      parts: [...f.entryResponse.parts, { partId: t.newId(), content }],
    },
  };
  s.target = "entry";
  s.dirty = true;
}

export function appendTimed(t: Turn, content: TemplateContent, offset: number) {
  const s = funnelState(t);
  const f = openFunnel(s);
  if (offset === 0 && !f.steps.length && f.entryResponse.parts.length < 20)
    return appendPrepared(t, content);
  if (f.lifecycle === "archived" || !f.entryResponse.parts.length)
    throw new CommunicationsError("revision_conflict");
  s.funnel = {
    ...f,
    steps: [
      ...f.steps,
      {
        stepId: t.newId(),
        delaySeconds: offset,
        delayAnchor: "entry",
        parts: [{ partId: t.newId(), content }],
      },
    ],
  };
  s.dirty = true;
  s.target = "entry";
}

export function showFunnel(t: Turn): void {
  const s = funnelState(t),
    f = s.funnel;
  s.prompt = undefined;
  if (!f) return performFunnel(t, { kind: "f:list" });
  const pending = t.compositionButtons(f.funnelId);
  t.reply(
    `${f.name}\n${names[f.lifecycle]}${s.dirty ? " · есть правки" : ""}\nСообщений: ${f.entryResponse.parts.length + f.steps.reduce((n, step) => n + step.parts.length, 0)}. Основная воронка: ${f.isDefault ? "да" : "нет"}.\n${f.steps
      .map((step, i) => `${i + 1}. Через ${stepTime(step)}`)
      .slice(0, 5)
      .join("\n")}`,
    [
      ...pending,
      ...(f.lifecycle !== "archived" && !pending.length
        ? [["Добавить сообщение", { kind: "sequence:funnel" }] as AuthorButton]
        : []),
      ...(s.dirty
        ? [["Сохранить черновик", { kind: "f:save" }] as AuthorButton]
        : []),
      ...(!s.dirty &&
      f.lifecycle !== "archived" &&
      f.revision &&
      f.revision !== f.publishedRevision
        ? [
            [
              f.publishedRevision === null
                ? "Включить воронку"
                : "Применить изменения",
              { kind: "f:preview" },
            ] as AuthorButton,
          ]
        : []),
      ...(f.lifecycle !== "archived"
        ? [["Сообщения", { kind: "f:messages" }] as AuthorButton]
        : []),
      ["Настройки", { kind: "f:settings" }],
      ...(f.lifecycle === "draft" && !f.isDefault
        ? [["Сделать основной", { kind: "f:default" }] as AuthorButton]
        : []),
      ...(f.lifecycle === "published"
        ? [
            [
              "Приостановить",
              { kind: "f:life", value: "pause" },
            ] as AuthorButton,
          ]
        : []),
      ...(f.lifecycle === "paused"
        ? [["Продолжить", { kind: "f:life", value: "resume" }] as AuthorButton]
        : []),
      ...(f.lifecycle !== "archived"
        ? [
            [
              "Отменить воронку",
              { kind: f.revision ? "f:confirm-archive" : "f:discard" },
            ] as AuthorButton,
          ]
        : []),
      ["Все воронки", { kind: "f:list" }],
    ],
  );
}

/**
 * The funnel's configuration. Saving, publication and the other lifecycle actions stay on its
 * card; an archived funnel is restored here.
 */
function settings(t: Turn) {
  const s = funnelState(t),
    f = openFunnel(s);
  t.reply(`Настройки · ${f.name}`, [
    ...t.compositionButtons(f.funnelId),
    ...(f.lifecycle !== "archived"
      ? ([
          ["Название", { kind: "f:name" }],
          ["Первый ответ", { kind: "f:parts", id: "entry" }],
          ["Шаги и задержки", { kind: "f:steps" }],
          ["Источники", { kind: "f:sources" }],
          [
            f.isDefault ? "Убрать из основных" : "Сделать основной",
            { kind: "f:default" },
          ],
        ] as Buttons)
      : [
          [
            "Восстановить",
            { kind: "f:life", value: "restore" },
          ] as AuthorButton,
        ]),
    ["Общий вводный блок", { kind: "f:intro" }],
    ...(s.dirty
      ? [["Отказаться от правок", { kind: "f:discard" }] as AuthorButton]
      : []),
    ...back,
  ]);
}

function parts(s: AuthorFunnelState): readonly MessagePart[] {
  if (s.target === "intro") return s.intro?.parts ?? [];
  if (s.target === "entry") return s.funnel?.entryResponse.parts ?? [];
  return s.funnel?.steps.find((step) => step.stepId === s.target)?.parts ?? [];
}

function replaceParts(s: AuthorFunnelState, parts: readonly MessagePart[]) {
  if (s.target === "intro" && s.intro) s.intro = { ...s.intro, parts };
  else if (s.funnel && s.target === "entry")
    s.funnel = {
      ...s.funnel,
      entryResponse: { ...s.funnel.entryResponse, parts },
    };
  else if (s.funnel)
    s.funnel = {
      ...s.funnel,
      steps: s.funnel.steps.map((step) =>
        step.stepId === s.target ? { ...step, parts } : step,
      ),
    };
  s.dirty = true;
}

/** The messages of the selected funnel block. */
export function selectedParts(t: Turn) {
  return parts(funnelState(t));
}

/** Applies an accepted message to its funnel block, or returns after a cancelled one. */
export function composeInFunnel(
  t: Turn,
  destination: Extract<MessageDestination, { kind: "funnel" }>,
  content: TemplateContent | undefined,
) {
  const s = funnelState(t);
  const id = s.target === "intro" ? s.intro?.introId : s.funnel?.funnelId;
  if (id !== destination.id || s.target !== destination.target)
    throw new CommunicationsError("revision_conflict");
  const missingStep =
    s.target !== "intro" &&
    s.target !== "entry" &&
    !s.funnel?.steps.some((step) => step.stepId === s.target);
  if (content) {
    const revision =
      s.target === "intro" ? s.intro?.revision : s.funnel?.revision;
    if (
      missingStep ||
      revision !== destination.expectedRevision ||
      (s.funnel?.lifecycle === "archived" && s.target !== "intro")
    )
      throw new CommunicationsError("revision_conflict");
    const current = parts(s);
    if (
      destination.partId &&
      !current.some((p) => p.partId === destination.partId)
    )
      throw new CommunicationsError("revision_conflict");
    if (
      !destination.partId &&
      current.length >=
        (s.target === "intro" || s.target === "entry" ? 100 : 20)
    )
      throw new CommunicationsError("unsupported_content");
    replaceParts(
      s,
      destination.partId
        ? current.map((p) =>
            p.partId === destination.partId ? { ...p, content } : p,
          )
        : [...current, { partId: t.newId(), content }],
    );
  }
  s.replacePartId = undefined;
  if (missingStep) return showFunnel(t);
  partsMenu(t);
}

function partsMenu(t: Turn, offset = 0) {
  const s = funnelState(t);
  const current = parts(s);
  const id = s.target === "intro" ? s.intro?.introId : s.funnel?.funnelId;
  const title =
    s.target === "intro"
      ? "Общий вводный блок"
      : s.target === "entry"
        ? "Первый ответ"
        : "Сообщения шага";
  t.reply(
    `${title}\n${
      current
        .slice(offset, offset + 10)
        .map((p, i) => `${offset + i + 1}. ${messageLabel(p.content, 100)}`)
        .join("\n") || "Добавьте сохранённый пост."
    }\nВыбранное содержимое сохраняется отдельно от исходного поста.${s.target === "intro" ? " После сохранения новые получатели увидят этот блок; прежним он повторно не придёт." : ""}`,
    [
      ...(id ? t.compositionButtons(id) : []),
      ...current
        .slice(offset, offset + 10)
        .map((part, i): AuthorButton => [
          `Сообщение ${offset + i + 1}`,
          { kind: "f:part", id: part.partId },
        ]),
      ...(offset > 0
        ? ([
            [
              "Предыдущие сообщения",
              { kind: "f:parts-page", value: String(offset - 10) },
            ],
          ] as Buttons)
        : []),
      ...(current.length > offset + 10
        ? ([
            [
              "Следующие сообщения",
              { kind: "f:parts-page", value: String(offset + 10) },
            ],
          ] as Buttons)
        : []),
      ["Создать сообщение", { kind: "compose:funnel" }],
      ["Добавить сохранённый пост", { kind: "f:posts" }],
      ...(current.length
        ? ([["Образцы себе", { kind: "f:sample" }]] as Buttons)
        : []),
      ...(s.target === "intro"
        ? ([
            ["Сохранить общий блок", { kind: "f:save-intro" }],
            // One way out keeps the save button on the first page of a short intro.
            ["Все воронки", { kind: "f:list" }],
          ] as Buttons)
        : back),
    ],
  );
}

export function performFunnel(t: Turn, a: FunnelEditorAction): void {
  switch (a.kind) {
    case "f:settings":
      return settings(t);
    case "f:messages":
      return messages(t, Number(a.value ?? 0));
    case "f:message":
      funnelState(t).target = a.value;
      return performFunnel(t, { kind: "f:part", id: a.id });
    case "f:timing": {
      const s = funnelState(t);
      s.timingPartId = a.id;
      s.prompt = "part-delay";
      return t.reply(
        timingAnchor(openFunnel(s), a.id) === "entry"
          ? "Когда отправить это сообщение? Пришлите время от входа: например, 20 минут или 1 день."
          : "Когда отправить это сообщение? Пришлите задержку: например, 20 минут или 1 день. Она отсчитывается после предыдущего шага; для первого отложенного шага — после входа. Новое отложенное сообщение добавится в конец цепочки.",
        [["Сразу при входе", { kind: "f:timing-entry", id: a.id }], ...back],
      );
    }
    case "f:timing-entry":
      return moveTimedPart(t, a.id, null);
    default:
      return performSelection(t, a);
  }
}

/** Clears the prompts that a navigation button leaves behind. */
function leavePrompts(t: Turn) {
  const s = funnelState(t);
  t.state.prompt = undefined;
  s.prompt = undefined;
  return s;
}

function performSelection(
  t: Turn,
  a: Exclude<FunnelEditorAction, PromptStep>,
): void {
  const s = leavePrompts(t);
  switch (a.kind) {
    case "f:discard": {
      const id = s.target === "intro" ? s.intro?.introId : s.funnel?.funnelId;
      if (id) {
        t.emit({ kind: "remove-draft", id });
        t.discardComposition(id);
      }
      t.state.funnelAuthor = {};
      return performFunnel(t, { kind: "f:list" });
    }
    case "f:list":
      t.retainFunnelDraft();
      return t.ask({ kind: "list-funnels", cursor: a.id });
    case "f:read":
      t.retainFunnelDraft();
      return t.ask({ kind: "read-funnel", funnelId: a.id });
    case "f:show":
      return showFunnel(t);
    case "f:intro":
      t.retainFunnelDraft();
      // Intro edits have their own scratch snapshot; navigation explicitly leaves a funnel draft.
      return t.ask({ kind: "read-intro" });
    case "f:parts":
      s.target = a.id;
      s.replacePartId = undefined;
      return partsMenu(t);
    case "f:parts-page":
      return partsMenu(t, Number(a.value));
    case "f:part": {
      const current = parts(s);
      const index = current.findIndex((p) => p.partId === a.id);
      const part = current[index];
      if (!part) throw new CommunicationsError("not_found");
      t.preview(part.content);
      return t.reply(
        `Сообщение ${index + 1} · ${part.content.type}\n${part.content.text.slice(0, 1000)}\nКнопок: ${part.content.buttons.length}`,
        [
          [
            "Изменить сообщение и кнопки",
            { kind: "compose:edit-funnel", id: part.partId },
          ],
          ...(s.target !== "intro"
            ? ([
                ["Когда отправить", { kind: "f:timing", id: part.partId }],
              ] as Buttons)
            : []),
          ["Заменить из сохранённых", { kind: "f:posts", value: part.partId }],
          ...(index > 0
            ? ([
                ["Выше", { kind: "f:move-part", id: part.partId, value: "-1" }],
              ] as Buttons)
            : []),
          ...(index < current.length - 1
            ? ([
                ["Ниже", { kind: "f:move-part", id: part.partId, value: "1" }],
              ] as Buttons)
            : []),
          ["Убрать сообщение", { kind: "f:remove-part", id: part.partId }],
          ["К сообщениям", { kind: "f:parts-page", value: "0" }],
        ],
      );
    }
    case "f:move-part":
    case "f:remove-part": {
      const current = [...parts(s)];
      const index = current.findIndex((p) => p.partId === a.id);
      if (index < 0) throw new CommunicationsError("not_found");
      if (a.kind === "f:remove-part") current.splice(index, 1);
      else {
        const next = index + Number(a.value);
        const [part, other] = [current[index], current[next]];
        if (part && other) [current[index], current[next]] = [other, part];
      }
      replaceParts(s, current);
      return partsMenu(t);
    }
    case "f:sample":
      for (const part of parts(s))
        t.emit({ kind: "message", content: part.content });
      return t.reply(
        "Образцы выбранных сообщений поставлены в очередь только вам.",
        [["К сообщениям", { kind: "f:parts-page", value: "0" }]],
      );
    case "f:save-intro":
      if (!s.intro) return performEdit(t, s, a);
      if (!s.intro.parts.length)
        return t.reply("Добавьте хотя бы один сохранённый пост.", [
          ["К сообщениям", { kind: "f:parts-page", value: "0" }],
        ]);
      return t.ask({
        kind: "validate-content",
        parts: s.intro.parts,
        purpose: "intro",
      });
    default:
      return performEdit(t, s, a);
  }
}

function performEdit(
  t: Turn,
  s: AuthorFunnelState,
  a: FunnelEdit | Extract<FunnelEditorAction, { kind: "f:save-intro" }>,
): void {
  const f = s.funnel;
  if (!f) return t.reply("Сначала откройте воронку.", root);
  if (f.lifecycle === "archived" && a.kind !== "f:life") return showFunnel(t);
  switch (a.kind) {
    case "f:name":
      s.prompt = "name";
      return t.reply("Напишите название воронки (до 128 символов).", back);
    case "f:default":
      s.funnel = { ...f, isDefault: !f.isDefault };
      s.dirty = true;
      return showFunnel(t);
    case "f:steps": {
      const offset = Number(a.value ?? 0);
      return t.reply(
        timedFromEntry(f.steps)
          ? "Шаги отправляются по времени от входа."
          : "Шаги отправляются по порядку.",
        [
          ...f.steps
            .slice(offset, offset + 15)
            .map((step, i): AuthorButton => [
              `Шаг ${offset + i + 1} · ${stepTime(step)}`,
              { kind: "f:step", id: step.stepId },
            ]),
          ...(offset > 0
            ? ([
                [
                  "Предыдущие шаги",
                  { kind: "f:steps", value: String(offset - 15) },
                ],
              ] as Buttons)
            : []),
          ...(f.steps.length > offset + 15
            ? ([
                [
                  "Следующие шаги",
                  { kind: "f:steps", value: String(offset + 15) },
                ],
              ] as Buttons)
            : []),
          ["Добавить шаг", { kind: "f:add-step" }],
          ...back,
        ],
      );
    }
    case "f:add-step": {
      if (f.steps.length >= 100)
        return t.reply("В воронке может быть до 100 шагов.", back);
      const fromEntry = timedFromEntry(f.steps);
      const step: FunnelStep = {
        stepId: t.newId(),
        delaySeconds: fromEntry
          ? Math.min((f.steps.at(-1)?.delaySeconds ?? 0) + 86400, MAX_DELAY)
          : 86400,
        ...(fromEntry && { delayAnchor: "entry" as const }),
        parts: [],
      };
      s.funnel = { ...f, steps: [...f.steps, step] };
      s.dirty = true;
      return performFunnel(t, { kind: "f:step", id: step.stepId });
    }
    case "f:step": {
      const index = f.steps.findIndex((step) => step.stepId === a.id);
      const step = f.steps[index];
      if (!step) throw new CommunicationsError("not_found");
      s.target = step.stepId;
      return t.reply(
        `Шаг ${index + 1}\nЧерез ${stepTime(step)}\nСообщений: ${step.parts.length}`,
        [
          ["Сообщения шага", { kind: "f:parts", id: step.stepId }],
          ["Задержка", { kind: "f:delay" }],
          ...(index > 0
            ? ([
                [
                  "Поднять шаг",
                  { kind: "f:move-step", id: step.stepId, value: "-1" },
                ],
              ] as Buttons)
            : []),
          ...(index < f.steps.length - 1
            ? ([
                [
                  "Опустить шаг",
                  { kind: "f:move-step", id: step.stepId, value: "1" },
                ],
              ] as Buttons)
            : []),
          ["Убрать шаг", { kind: "f:remove-step", id: step.stepId }],
          ["Все шаги", { kind: "f:steps" }],
        ],
      );
    }
    case "f:delay":
      s.prompt = "delay";
      return t.reply(
        f.steps.find((step) => step.stepId === s.target)?.delayAnchor ===
          "entry"
          ? "Напишите время от входа: 30 мин, 2 ч, 1 д или 0 для отправки сразу после первого ответа."
          : "Напишите задержку: 30 мин, 2 ч, 1 д или 0 для отправки сразу после предыдущего шага.",
        back,
      );
    case "f:move-step":
    case "f:remove-step": {
      const steps = [...f.steps];
      const index = steps.findIndex((step) => step.stepId === a.id);
      if (index < 0) throw new CommunicationsError("not_found");
      if (a.kind === "f:remove-step") steps.splice(index, 1);
      else {
        const next = index + Number(a.value);
        const [step, other] = [steps[index], steps[next]];
        // Steps timed from entry keep their times in place, so moving a step moves its messages.
        if (step && other)
          [steps[index], steps[next]] = timedFromEntry(f.steps)
            ? [
                { ...other, delaySeconds: step.delaySeconds },
                { ...step, delaySeconds: other.delaySeconds },
              ]
            : [other, step];
      }
      s.funnel = { ...f, steps };
      s.dirty = true;
      return performFunnel(t, { kind: "f:steps" });
    }
    case "f:sources": {
      const offset = Number(a.value ?? 0);
      return t.reply(
        "Источники входа. Код применяется после публикации. Ссылка бота должна содержать ?start=код.",
        [
          ...f.sources
            .slice(offset, offset + 15)
            .map((source): AuthorButton => [
              source.name.slice(0, 50),
              { kind: "f:source", id: source.sourceId },
            ]),
          ...(offset > 0
            ? ([
                [
                  "Предыдущие источники",
                  { kind: "f:sources", value: String(offset - 15) },
                ],
              ] as Buttons)
            : []),
          ...(f.sources.length > offset + 15
            ? ([
                [
                  "Следующие источники",
                  { kind: "f:sources", value: String(offset + 15) },
                ],
              ] as Buttons)
            : []),
          ["Добавить источник", { kind: "f:add-source" }],
          ...back,
        ],
      );
    }
    case "f:source": {
      const source = f.sources.find((item) => item.sourceId === a.id);
      if (!source) throw new CommunicationsError("not_found");
      return t.reply(
        `${source.name}\nКод: ${source.code}\nПараметр ссылки: ?start=${source.code}`,
        [
          ["Убрать источник", { kind: "f:remove-source", id: source.sourceId }],
          ["Все источники", { kind: "f:sources" }],
        ],
      );
    }
    case "f:add-source":
      if (f.sources.length >= 100)
        return t.reply("В воронке может быть до 100 источников.", back);
      s.prompt = "source-name";
      return t.reply(
        "Как назвать источник? Например: канал или описание видео.",
        back,
      );
    case "f:remove-source":
      s.funnel = {
        ...f,
        sources: f.sources.filter((item) => item.sourceId !== a.id),
      };
      s.dirty = true;
      return performFunnel(t, { kind: "f:sources" });
    case "f:save":
      return t.ask({ kind: "save-funnel", funnel: f, then: { kind: "card" } });
    case "f:preview":
    case "f:publish":
      if (s.dirty || !f.revision)
        return t.reply(
          "Сначала сохраните черновик. Проверка и публикация относятся к сохранённой версии.",
          back,
        );
      // Read locks definition changes through this transaction. Validation is answered for
      // exactly these parts outside the transaction, so it covers precisely the locked revision.
      return t.ask({
        kind: "lock-funnel",
        funnelId: f.funnelId,
        publish: a.kind === "f:publish",
      });
    case "f:confirm-archive":
      return t.reply(
        "Отменить воронку? Новые сообщения больше не будут отправляться. Уже доставленные останутся у получателей.",
        [["Да, отменить", { kind: "f:life", value: "archive" }], ...back],
      );
    case "f:life":
      if (s.dirty && a.value !== "archive") return showFunnel(t);
      return t.ask({
        kind: "change-funnel",
        funnelId: f.funnelId,
        revision: f.revision,
        action: a.value,
      });
    case "f:save-intro":
      return showFunnel(t);
    default:
      return unhandled(a, "funnel action");
  }
}

function messages(t: Turn, offset: number) {
  const f = openFunnel(funnelState(t));
  const entries = [
    ...f.entryResponse.parts.map((p) => ({
      p,
      target: "entry",
      when: "При входе",
    })),
    ...f.steps.flatMap((step) =>
      step.parts.map((p) => ({
        p,
        target: step.stepId,
        when: `Через ${formatFunnelDelay(step.delaySeconds)}`,
      })),
    ),
  ];
  t.reply(
    `${f.name} · сообщения\n${
      timedFromEntry(f.steps)
        ? "Время отсчитывается от входа."
        : f.steps.some((step) => step.delayAnchor === "entry")
          ? "Время каждого шага указано в настройках, в разделе «Шаги и задержки»."
          : "Задержка шага отсчитывается после предыдущего шага."
    } Выберите сообщение для настройки.`,
    [
      ...entries
        .slice(offset, offset + 5)
        .map(({ p, target, when }, i): AuthorButton => [
          `${offset + i + 1}. ${when} · ${messageLabel(p.content, 25)}`,
          { kind: "f:message", id: p.partId, value: target },
        ]),
      ...(offset > 0
        ? [
            [
              "Предыдущие",
              { kind: "f:messages", value: String(offset - 5) },
            ] as AuthorButton,
          ]
        : []),
      ...(entries.length > offset + 5
        ? [
            [
              "Следующие",
              { kind: "f:messages", value: String(offset + 5) },
            ] as AuthorButton,
          ]
        : []),
      ["Добавить сообщения", { kind: "batch:funnel" }],
      ...back,
    ],
  );
}

/**
 * Moves one message to the entry response (`delaySeconds` null) or to its own delayed step.
 * A message already published in another step keeps its place: moving it would rewrite
 * delivery history. `published` is the answer about that history, once the move needs it.
 */
function moveTimedPart(
  t: Turn,
  partId: string,
  delaySeconds: number | null,
  published?: boolean,
) {
  const s = funnelState(t),
    f = openFunnel(s);
  if (f.lifecycle === "archived")
    throw new CommunicationsError("revision_conflict");
  const source = f.steps.find((step) =>
    step.parts.some((p) => p.partId === partId),
  );
  const part =
    source?.parts.find((p) => p.partId === partId) ??
    f.entryResponse.parts.find((p) => p.partId === partId);
  if (!part) throw new CommunicationsError("revision_conflict");
  if (!(delaySeconds === null && !source)) {
    if (!(delaySeconds !== null && source?.parts.length === 1)) {
      if (published === undefined)
        return t.ask({
          kind: "read-part-history",
          funnelId: f.funnelId,
          partId,
          delaySeconds,
        });
      if (published)
        return t.reply(
          delaySeconds === null
            ? "Это сообщение уже публиковалось в другом шаге. Его перенос изменил бы историю отправок. Добавьте новое сообщение в нужный шаг; задержку существующего шага можно менять."
            : "Это сообщение уже публиковалось в другом шаге. Добавьте новое сообщение в нужный шаг; задержку существующего шага можно менять.",
          back,
        );
    }
    if (delaySeconds !== null && !source && f.entryResponse.parts.length === 1)
      throw new CommunicationsError("malformed");
    if (delaySeconds !== null && source?.parts.length === 1)
      s.funnel = {
        ...f,
        steps: inTimeOrder(
          f.steps.map((step) =>
            step.stepId === source.stepId ? { ...step, delaySeconds } : step,
          ),
        ),
      };
    else {
      const entry = f.entryResponse.parts.filter((p) => p.partId !== partId);
      const steps = f.steps
        .map((step) => ({
          ...step,
          parts: step.parts.filter((p) => p.partId !== partId),
        }))
        .filter((step) => step.parts.length);
      s.funnel = {
        ...f,
        entryResponse: {
          ...f.entryResponse,
          parts: delaySeconds === null ? [...entry, part] : entry,
        },
        steps:
          delaySeconds === null
            ? steps
            : inTimeOrder([
                ...steps,
                {
                  stepId: t.newId(),
                  delaySeconds,
                  ...(timedFromEntry(f.steps) && {
                    delayAnchor: "entry" as const,
                  }),
                  parts: [part],
                },
              ]),
      };
    }
    s.dirty = true;
  }
  s.prompt = undefined;
  s.timingPartId = undefined;
  performFunnel(t, { kind: "f:messages" });
}

export function answerFunnel(t: Turn, input: { text: string }) {
  const s = funnelState(t);
  const f = s.funnel;
  const text = input.text.trim();
  if (!f) return t.reply("Откройте воронку заново.", root);
  switch (s.prompt) {
    case "part-delay": {
      const delay = parseFunnelDelay(text);
      if (delay === undefined)
        return t.reply(
          "Введите задержку: например, 20 минут или 1 день.",
          back,
        );
      if (s.target === "entry" && f.entryResponse.parts.length === 1)
        return t.reply(
          "Оставьте хотя бы одно сообщение при входе. Остальные можно перенести в отложенные шаги.",
          back,
        );
      return moveTimedPart(t, s.timingPartId ?? "", delay);
    }
    case "name":
    case "source-name":
      if (!text || text.length > 128)
        return t.reply("Нужно от 1 до 128 символов.", back);
      if (s.prompt === "source-name") {
        s.sourceName = text;
        s.prompt = "source-code";
        return t.reply(
          "Напишите уникальный код: m_ и от 1 до 40 латинских букв, цифр, _ или -. Например m_youtube.",
          back,
        );
      }
      s.funnel = { ...f, name: text };
      s.dirty = true;
      return showFunnel(t);
    case "source-code":
      if (
        !/^m_[A-Za-z0-9_-]{1,40}$/.test(text) ||
        f.sources.some((source) => source.code === text)
      )
        return t.reply(
          "Код должен начинаться с m_ и быть уникальным. После префикса — от 1 до 40 латинских букв, цифр, _ или -.",
          back,
        );
      if (s.sourceName === undefined)
        throw new CommunicationsError("malformed");
      s.funnel = {
        ...f,
        sources: [
          ...f.sources,
          { sourceId: t.newId(), name: s.sourceName, code: text },
        ],
      };
      s.dirty = true;
      return performFunnel(t, { kind: "f:sources" });
    case "delay": {
      const delaySeconds = parseFunnelDelay(text);
      if (delaySeconds === undefined)
        return t.reply(
          "Не удалось понять задержку. Примеры: 30 мин, 2 ч, 1 д, 0.",
          back,
        );
      s.funnel = {
        ...f,
        steps: inTimeOrder(
          f.steps.map((step) =>
            step.stepId === s.target ? { ...step, delaySeconds } : step,
          ),
        ),
      };
      s.dirty = true;
      if (!s.target) throw new CommunicationsError("not_found");
      return performFunnel(t, { kind: "f:step", id: s.target });
    }
    case undefined:
      return showFunnel(t);
    default:
      return unhandled(s.prompt, "funnel prompt");
  }
}

/** Continues a funnel step after the executing layer answered its query. */
export function answerFunnelQuery(
  t: Turn,
  event: Extract<
    AuthorEvent,
    {
      kind:
        | "funnels-listed"
        | "funnel-read"
        | "intro-read"
        | "content-validated"
        | "intro-saved"
        | "funnel-locked"
        | "funnel-published"
        | "publication-previewed"
        | "funnel-changed"
        | "part-history-read";
    }
  >,
): void {
  switch (event.kind) {
    case "funnels-listed":
      t.state.funnelAuthor = {};
      return t.reply("Воронки · черновики сохраняются при каждом действии", [
        ["Создать воронку", { kind: "f:new" }],
        ...event.items.map(({ id, name, status }): AuthorButton => [
          `${name.slice(0, 40)} · ${status === "edited" ? "есть правки" : names[status]}`,
          { kind: "f:read", id },
        ]),
        ...(event.nextCursor
          ? [
              [
                "Следующие воронки",
                { kind: "f:list", id: event.nextCursor },
              ] as AuthorButton,
            ]
          : []),
        ["В меню", { kind: "home" }],
      ]);
    case "funnel-read":
      t.state.funnelAuthor = event.funnelAuthor;
      return showFunnel(t);
    case "intro-read":
      t.state.funnelAuthor = event.funnelAuthor;
      return partsMenu(t);
    case "content-validated": {
      const s = funnelState(t);
      const result = event.result;
      if (event.purpose === "intro") {
        if (result.status !== "ok" || result.targetErrors.length)
          return t.reply(
            "Общий блок не сохранён: проверка материалов недоступна или ссылки ведут на недоступные материалы.",
            [["К сообщениям", { kind: "f:parts-page", value: "0" }]],
          );
        if (!s.intro) throw new CommunicationsError("not_found");
        return t.ask({ kind: "save-intro", intro: s.intro });
      }
      if (result.status !== "ok")
        return t.reply(
          result.status === "denied"
            ? "Право автора не подтверждено. Публикация недоступна."
            : "Не удалось проверить материалы в Platform. Попробуйте проверку позже; публикации не было.",
          back,
        );
      if (result.targetErrors.length)
        return t.reply(
          `Публикация недоступна. Исправьте ссылки в выбранных постах:\n${result.targetErrors
            .slice(0, 10)
            .map(
              (error) =>
                `${error.url.slice(0, 200)} — ${{ not_found: "не найдено", not_published: "не опубликовано", not_free: "нет бесплатного доступа", incomplete: "серия не готова" }[error.reason]}`,
            )
            .join("\n")}`,
          back,
        );
      const f = openFunnel(s);
      return t.ask({
        kind: "publish-funnel",
        funnelId: f.funnelId,
        revision: f.revision,
        publish: event.purpose === "publish",
      });
    }
    case "intro-saved": {
      const s = funnelState(t);
      if (event.intro) s.intro = event.intro;
      s.dirty = false;
      return t.reply(
        "Общий вводный блок сохранён для будущих получателей. Уже получившим его повторной отправки не будет.",
        root,
      );
    }
    case "funnel-locked": {
      const f = openFunnel(funnelState(t));
      if (event.revision !== f.revision)
        throw new CommunicationsError("revision_conflict");
      return t.ask({
        kind: "validate-content",
        parts: [
          ...f.entryResponse.parts,
          ...f.steps.flatMap((step) => step.parts),
        ],
        purpose: event.publish ? "publish" : "preview",
      });
    }
    case "funnel-published":
      funnelState(t).funnel = event.funnel;
      return showFunnel(t);
    case "publication-previewed": {
      const p = event.preview;
      return t.reply(
        `Публикация версии ${p.revision}\nНовых шагов: ${p.addedStepIds.length}\nИзменённых: ${p.editedStepIds.length}\nУдалённых: ${p.deletedStepIds.length}\nПорядок изменён: ${p.reorderedStepIds.length}\nПолучателей продолжения: ${p.eligibleContacts}\nИз них уже завершили прежнюю воронку: ${p.completedParticipantsReceivingNewSteps}\nУже доставленное повторно не отправляется.`,
        [["Опубликовать воронку", { kind: "f:publish" }], ...back],
      );
    }
    case "funnel-changed": {
      const s = funnelState(t);
      const f = openFunnel(s);
      if (event.funnel) {
        s.funnel = event.funnel;
        s.dirty = false;
        t.emit({ kind: "remove-draft", id: f.funnelId });
      }
      return showFunnel(t);
    }
    case "part-history-read":
      return moveTimedPart(
        t,
        event.partId,
        event.delaySeconds,
        event.published,
      );
    default:
      return unhandled(event, "funnel answer");
  }
}

/** Applies a saved funnel; the caller decides what the author sees next. */
export function applyFunnelSave(t: Turn, funnel: FunnelSnapshot | undefined) {
  const s = funnelState(t);
  if (funnel) s.funnel = funnel;
  s.dirty = false;
}

/** The author asked to save a draft that the contract does not accept yet. */
export function rejectFunnelSave(t: Turn) {
  t.reply(
    "Добавьте хотя бы один пост в первый ответ и в каждый шаг, затем сохраните черновик.",
    back,
  );
}

export function parseFunnelDelay(value: string): number | undefined {
  const match =
    /^(\d+)\s*(с|сек(?:унда|унды|унд)?|мин(?:ута|уты|ут)?|м|ч|час(?:а|ов)?|д|дн(?:я|ей)?|день)?$/iu.exec(
      value.trim().toLowerCase(),
    );
  if (!match) return undefined;
  const factors: Record<string, number> = {
    с: 1,
    сек: 1,
    мин: 60,
    м: 60,
    ч: 3600,
    час: 3600,
    д: 86400,
    дн: 86400,
  };
  const seconds =
    Number(match[1]) *
    (factors[match[2]?.toLowerCase() ?? "с"] ??
      (match[2]?.startsWith("мин")
        ? 60
        : match[2]?.startsWith("час")
          ? 3600
          : match[2]?.startsWith("д")
            ? 86400
            : 1));
  return Number.isSafeInteger(seconds) && seconds <= MAX_DELAY
    ? seconds
    : undefined;
}
/** When a delayed step is sent, as the author reads it. */
function stepTime(step: FunnelStep) {
  return `${formatFunnelDelay(step.delaySeconds)} ${step.delayAnchor === "entry" ? "от входа" : "после предыдущего шага"}`;
}

/**
 * Whether every step counts from entry, as the bot has authored funnels since #43. New steps of
 * such a funnel count from entry too, and its step order follows time.
 */
function timedFromEntry(steps: readonly FunnelStep[]) {
  return steps.every((step) => step.delayAnchor === "entry");
}

/** The anchor of a message's new time: a step with only this message keeps its own anchor. */
function timingAnchor(f: FunnelSnapshot, partId: string) {
  const own = f.steps.find(
    (step) => step.parts.length === 1 && step.parts[0]?.partId === partId,
  );
  return own ? own.delayAnchor : timedFromEntry(f.steps) ? "entry" : undefined;
}

/** Sorts steps timed from entry by time; a chain of steps keeps the author's order. */
function inTimeOrder(steps: readonly FunnelStep[]): FunnelStep[] {
  return timedFromEntry(steps)
    ? [...steps].sort((a, b) => a.delaySeconds - b.delaySeconds)
    : [...steps];
}

export function formatFunnelDelay(seconds: number): string {
  for (const [unit, factor] of [
    ["д", 86400],
    ["ч", 3600],
    ["мин", 60],
  ] as const)
    if (seconds > 0 && seconds % factor === 0)
      return `${seconds / factor} ${unit}`;
  return `${seconds} с`;
}
