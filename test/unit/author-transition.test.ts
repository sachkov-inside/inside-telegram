import { describe, expect, it } from "vitest";
import {
  emptyAuthorState,
  type AuthorBroadcast,
  type AuthorState,
} from "../../src/modules/communications/author-dialog.js";
import { transition } from "../../src/modules/communications/author-transition.js";
import type {
  AuthorEffect,
  AuthorEvent,
  DialogEnvironment,
} from "../../src/modules/communications/author-turn.js";
import type { TemplateContent } from "../../src/modules/communications/communications-contract.js";
import type { FunnelSnapshot } from "../../src/modules/communications/funnel-types.js";

const now = new Date("2030-01-01T09:00:00.000Z");

function uuid(n: number) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function text(value: string): TemplateContent {
  return { type: "text", text: value, entities: [], buttons: [] };
}

function broadcast(overrides: Partial<AuthorBroadcast> = {}): AuthorBroadcast {
  return {
    broadcastId: uuid(900),
    revision: 1,
    state: "draft",
    parts: [
      { partId: uuid(901), content: text("Первое"), sendAfterSeconds: 0 },
    ],
    audience: { kind: "all" },
    scheduledAt: null,
    audienceSnapshotId: null,
    snapshotSize: 0,
    ...overrides,
  };
}

function funnel(overrides: Partial<FunnelSnapshot> = {}): FunnelSnapshot {
  return {
    funnelId: uuid(800),
    name: "Прогрев",
    isDefault: false,
    entryResponse: {
      stepId: uuid(801),
      parts: [{ partId: uuid(802), content: text("Вход") }],
    },
    steps: [],
    sources: [],
    revision: 2,
    publishedRevision: 1,
    lifecycle: "published",
    ...overrides,
  };
}

/** Drives the dialog as the executor does, keeping the menu the author sees. */
class Dialog {
  effects: readonly AuthorEffect[] = [];
  menu?: Extract<AuthorEffect, { kind: "menu" }>;
  private ids = 0;
  pending = new Set<string>();

  constructor(public state: AuthorState = emptyAuthorState("start")) {}

  get env(): DialogEnvironment {
    return {
      pendingCompositions: this.pending,
      now,
      newId: () => uuid(++this.ids),
    };
  }

  send(event: AuthorEvent) {
    const next = transition(this.state, event, this.env);
    this.state = next.state;
    this.effects = next.effects;
    const menus = next.effects.filter((effect) => effect.kind === "menu");
    this.menu = menus.at(-1) ?? this.menu;
    for (const effect of next.effects)
      if (effect.kind === "discard-composition") this.pending.delete(effect.id);
    return this;
  }

  click(label: string) {
    const button = this.menu?.buttons.find((b) => b.text === label);
    expect(button, `${label}: ${this.labels().join(", ")}`).toBeDefined();
    return this.send({ kind: "callback", data: button!.callbackData });
  }

  write(value: string, content: unknown = text(value)) {
    return this.send({ kind: "text", text: value, content });
  }

  labels() {
    return this.menu?.buttons.map((b) => b.text) ?? [];
  }

  kinds() {
    return this.effects.map((effect) => effect.kind);
  }

  /** The query that ended the last transition. */
  query<Kind extends AuthorEffect["kind"]>(kind: Kind) {
    const last = this.effects.at(-1);
    expect(last?.kind).toBe(kind);
    return last as Extract<AuthorEffect, { kind: Kind }>;
  }
}

describe("main menu", () => {
  it("opens the home menu and starts a fresh session", () => {
    const dialog = new Dialog({
      ...emptyAuthorState("old"),
      broadcast: broadcast(),
    }).send({ kind: "open" });

    expect(dialog.menu).toMatchObject({
      text: "Админка коммуникаций. Текст и медиа готовьте здесь, в Telegram.",
      fresh: false,
    });
    expect(dialog.labels()).toEqual(["Рассылки", "Воронки", "Статистика"]);
    expect(dialog.state.broadcast).toBeUndefined();
    expect(dialog.menu!.buttons[0]!.callbackData).toBe(
      `author:${dialog.state.token}:0`,
    );
    expect(dialog.state.actions).toEqual([
      { kind: "broadcasts" },
      { kind: "f:list" },
      { kind: "overview" },
    ]);
  });

  it("asks for statistics and shows the answer", () => {
    const dialog = new Dialog().send({ kind: "open" }).click("Статистика");
    expect(dialog.query("read-statistics")).toEqual({
      kind: "read-statistics",
    });

    dialog.send({
      kind: "statistics-read",
      deliveries: {
        sent: 3,
        pending: 1,
        suppressed: 0,
        failed: 0,
        unknown: 0,
        partialCancelled: 0,
      },
    });

    expect(dialog.menu!.text).toBe(
      "Статистика сообщений\nОтправлено: 3\nОжидает: 1\nПропущено: 0\nОшибки: 0\nНеизвестный результат: 0",
    );
    expect(() =>
      transition(dialog.state, { kind: "statistics-read" }, dialog.env),
    ).toThrow("malformed");
  });

  it("keeps an edited funnel as a draft when the author goes home", () => {
    const edited = { funnel: funnel(), dirty: true };
    const dialog = new Dialog({
      ...emptyAuthorState("menu"),
      actions: [{ kind: "home" }],
      funnelAuthor: edited,
    }).send({ kind: "callback", data: "author:menu:0" });

    expect(dialog.effects[0]).toEqual({
      kind: "retain-funnel-draft",
      funnelAuthor: edited,
    });
    expect(dialog.menu!.text).toBe("Админка коммуникаций");
    expect(dialog.state.funnelAuthor).toBeUndefined();
  });

  it("answers text outside any prompt with the home menu", () => {
    const dialog = new Dialog({
      ...emptyAuthorState("menu"),
      broadcast: broadcast(),
    }).write("привет");

    expect(dialog.menu!.text).toBe(
      "Выберите «Рассылки» или «Воронки», чтобы добавить сообщения.",
    );
    expect(dialog.state.broadcast).toBeUndefined();
  });

  it("restarts from home after a step failed on changed data", () => {
    for (const [during, message] of [
      ["callback", "Пост, рассылка или воронка изменились"],
      ["text", "Данные изменились"],
    ] as const) {
      const dialog = new Dialog({
        ...emptyAuthorState("menu"),
        broadcast: broadcast(),
      }).send({ kind: "failed", during });
      expect(dialog.menu!.text).toContain(message);
      expect(dialog.labels()).toEqual(["Рассылки", "Воронки", "Статистика"]);
      expect(dialog.state.broadcast).toBeUndefined();
    }
  });
});

describe("stale menu", () => {
  it("resets a button from an older menu to home", () => {
    const dialog = new Dialog({
      ...emptyAuthorState("current"),
      broadcast: broadcast(),
    }).send({ kind: "callback", data: "author:older:0" });

    expect(dialog.menu!.text).toBe(
      "Это меню уже устарело. Незавершённое сообщение сохранено, если вы начали его создание.",
    );
    expect(dialog.labels()).toEqual(["Рассылки", "Воронки", "Статистика"]);
    expect(dialog.state.broadcast).toBeUndefined();
  });

  it("keeps an unfinished message and offers to continue it", () => {
    const composing = {
      destination: {
        kind: "broadcast" as const,
        id: uuid(900),
        expectedRevision: 1,
      },
      prompt: "capture" as const,
    };
    const dialog = new Dialog({ ...emptyAuthorState("current"), composing });
    dialog.pending.add(uuid(900));
    dialog.send({ kind: "callback", data: "author:older:3" });

    expect(dialog.labels()).toEqual([
      "Продолжить сообщение",
      "Отменить добавление",
    ]);
    expect(dialog.state.composing).toEqual(composing);
  });

  it("offers an unfinished message on its broadcast card after the session started over", () => {
    // An untrusted stored session starts over; unfinished messages live outside it.
    const dialog = new Dialog(emptyAuthorState("fresh"));
    dialog.pending.add(uuid(900));
    dialog.send({ kind: "callback", data: "author:old:0" });
    expect(dialog.labels()).toEqual(["Рассылки", "Воронки", "Статистика"]);
    expect(dialog.kinds()).not.toContain("discard-composition");

    dialog.send({
      kind: "callback",
      data: `author:open-broadcast:${uuid(900)}`,
    });
    dialog.send({
      kind: "broadcast-read",
      broadcast: broadcast(),
      name: "Анонс",
    });
    expect(dialog.labels()).toContain("Продолжить сообщение");
  });

  it("still opens home, the broadcast list and a broadcast link", () => {
    const dialog = new Dialog(emptyAuthorState("current"));
    dialog.send({ kind: "callback", data: "author:broadcasts:0" });
    expect(dialog.query("list-broadcasts")).toEqual({
      kind: "list-broadcasts",
    });
    dialog.send({
      kind: "callback",
      data: `author:open-broadcast:${uuid(900)}`,
    });
    expect(dialog.query("read-broadcast")).toEqual({
      kind: "read-broadcast",
      broadcastId: uuid(900),
    });
  });
});

describe("broadcast", () => {
  it("takes messages with send times and saves each before asking for the next", () => {
    const dialog = new Dialog().send({ kind: "open" }).click("Рассылки");
    dialog.send({
      kind: "broadcasts-listed",
      items: [{ broadcast: broadcast(), name: "Анонс" }],
    });
    expect(dialog.labels()).toEqual([
      "Создать рассылку",
      "Анонс · Черновик",
      "В меню",
    ]);

    dialog.click("Создать рассылку");
    expect(dialog.kinds()).toEqual(["retain-broadcast", "menu"]);
    expect(dialog.labels()).toEqual(["Готово"]);
    const id = dialog.state.broadcast!.broadcastId;

    dialog.write("Первое");
    expect(dialog.labels()).toEqual([
      "Сразу",
      "Через 1 ч",
      "Через 2 ч",
      "Не добавлять это сообщение",
    ]);

    dialog.click("Сразу");
    const save = dialog.query("save-broadcast");
    expect(save.then).toEqual({ kind: "next-message", destinationId: id });
    expect(save.broadcast.parts).toMatchObject([
      { content: text("Первое"), sendAfterSeconds: 0 },
    ]);
    expect(dialog.state.broadcastName).toBe("Первое");

    dialog.send({
      kind: "broadcast-saved",
      broadcast: { ...save.broadcast, revision: 1 },
      then: save.then,
    });
    expect(dialog.kinds()).toEqual([
      "retain-broadcast",
      "discard-composition",
      "menu",
    ]);
    expect(dialog.state.composing?.destination.expectedRevision).toBe(1);

    dialog.write("Второе").click("Через 1 ч");
    expect(dialog.query("save-broadcast").broadcast.parts).toHaveLength(2);
    dialog.send({
      kind: "broadcast-saved",
      broadcast: { ...dialog.query("save-broadcast").broadcast, revision: 2 },
      then: dialog.query("save-broadcast").then,
    });
    dialog.write("Третье");
    expect(dialog.menu!.text).toContain("Не раньше 1 ч");
    expect(dialog.labels()).toEqual([
      "Через 1 ч",
      "Через 2 ч",
      "Не добавлять это сообщение",
    ]);

    dialog.click("Не добавлять это сообщение").click("Готово");
    expect(dialog.kinds()).toEqual(["discard-composition", "menu"]);
    expect(dialog.labels()).toEqual([
      "Добавить сообщение",
      "Запустить",
      "Отменить рассылку",
      "Посмотреть сообщения",
      "Все рассылки",
    ]);
    expect(dialog.menu!.text).toContain("2. Через 1 ч · 📝 Текст · Второе");
  });

  it("rejects a message whose broadcast changed after the author started it", () => {
    const dialog = new Dialog({
      ...emptyAuthorState("menu"),
      broadcast: broadcast({ revision: 3 }),
      composing: {
        destination: { kind: "broadcast", id: uuid(900), expectedRevision: 1 },
        sequence: { lastOffset: 0, firstEntry: false },
        content: text("Второе"),
      },
    });

    expect(() => dialog.write("сразу")).toThrow("revision_conflict");
  });

  it("launches only after confirmation and shows the new state", () => {
    const dialog = new Dialog({
      ...emptyAuthorState("menu"),
      actions: [{ kind: "confirm-launch" }],
      broadcast: broadcast(),
      broadcastName: "Анонс",
    }).send({ kind: "callback", data: "author:menu:0" });

    expect(dialog.menu!.text).toBe(
      "Запустить «Анонс»?\n1 сообщений, версия 1.\nКому: все доступные контакты.\nКогда: сразу после подтверждения.",
    );
    dialog.click("Запустить рассылку");
    expect(dialog.query("change-broadcast")).toEqual({
      kind: "change-broadcast",
      broadcastId: uuid(900),
      revision: 1,
      operation: "launch",
    });

    dialog.send({
      kind: "broadcast-changed",
      broadcast: broadcast({ state: "running", revision: 2 }),
    });
    expect(dialog.labels()).toEqual([
      "Приостановить",
      "Отменить рассылку",
      "Посмотреть сообщения",
      "Результаты отправки",
      "Все рассылки",
    ]);
  });

  it("asks for a message before launching a broadcast that was never saved", () => {
    const dialog = new Dialog({
      ...emptyAuthorState("menu"),
      actions: [{ kind: "launch" }],
      broadcast: broadcast({ revision: 0, parts: [] }),
    }).send({ kind: "callback", data: "author:menu:0" });

    expect(dialog.menu!.text).toBe(
      "Добавьте хотя бы одно сообщение перед запуском.",
    );
    expect(dialog.kinds()).toEqual(["menu"]);
  });

  it("offers to continue an unfinished message instead of a new one", () => {
    const dialog = new Dialog({
      ...emptyAuthorState("menu"),
      actions: [{ kind: "read-broadcast", id: uuid(900) }],
    });
    dialog.pending.add(uuid(900));
    dialog.send({ kind: "callback", data: "author:menu:0" });
    dialog.send({
      kind: "broadcast-read",
      broadcast: broadcast(),
      name: "Анонс",
    });

    expect(dialog.labels()).toEqual([
      "Продолжить сообщение",
      "Отменить добавление",
      "Отменить рассылку",
      "Посмотреть сообщения",
      "Все рассылки",
    ]);
  });

  it("confirms the Moscow launch time a broadcast was scheduled for through the API", () => {
    const dialog = new Dialog({
      ...emptyAuthorState("menu"),
      actions: [{ kind: "confirm-launch" }],
      broadcast: broadcast({ scheduledAt: "2030-01-01T09:30:00.000Z" }),
      broadcastName: "Анонс",
    }).send({ kind: "callback", data: "author:menu:0" });

    expect(dialog.menu!.text).toContain("Когда: 01.01.2030, 12:30:00 · Москва");
  });
});

describe("composer", () => {
  function editing() {
    const dialog = new Dialog({
      ...emptyAuthorState("menu"),
      actions: [{ kind: "show-part", id: uuid(901) }],
      broadcast: broadcast(),
    }).send({ kind: "callback", data: "author:menu:0" });
    expect(dialog.kinds()).toEqual(["message", "menu"]);
    return dialog.click("Изменить сообщение и кнопки");
  }

  it("previews the part and edits it without changing the broadcast", () => {
    const dialog = editing();

    expect(dialog.kinds()).toEqual(["message", "menu"]);
    expect(dialog.menu!.fresh).toBe(true);
    expect(dialog.labels()).toEqual([
      "Заменить сообщение",
      "Посмотреть сообщение",
      "Добавить кнопку",
      "Прислать другое",
      "Отмена",
    ]);
    expect(dialog.state.composing!.destination).toEqual({
      kind: "broadcast",
      id: uuid(900),
      expectedRevision: 1,
      partId: uuid(901),
    });
  });

  it("adds a button in two answers and rejects an unsafe link", () => {
    const dialog = editing().click("Добавить кнопку").write("Купить");
    expect(dialog.menu!.text).toBe("Пришлите HTTPS-ссылку для кнопки.");

    dialog.write("http://example.com");
    expect(dialog.menu!.text).toBe(
      "Нужна корректная HTTPS-ссылка без пароля или служебного адреса Telegram.",
    );

    dialog.write("https://example.com/buy");
    expect(dialog.labels()).toContain("Убрать кнопку: Купить");
    expect(dialog.state.composing!.content!.buttons).toEqual([
      { text: "Купить", url: "https://example.com/buy", row: 0 },
    ]);
    expect(dialog.state.broadcast!.parts[0]!.content.buttons).toEqual([]);
  });

  it("replaces the part only after acceptance", () => {
    const dialog = editing().click("Прислать другое").write("Новый текст");
    dialog.click("Заменить сообщение");

    expect(dialog.kinds()).toEqual(["discard-composition", "save-broadcast"]);
    const save = dialog.query("save-broadcast");
    expect(save.broadcast.parts).toEqual([
      { partId: uuid(901), content: text("Новый текст"), sendAfterSeconds: 0 },
    ]);
    expect(save.then).toEqual({ kind: "card" });
    expect(dialog.state.composing).toBeUndefined();

    dialog.send({
      kind: "broadcast-saved",
      broadcast: save.broadcast,
      then: save.then,
    });
    expect(dialog.labels()).toContain("Все рассылки");
  });

  it("drops the unfinished message on /cancel and returns to the broadcast", () => {
    const dialog = editing().send({ kind: "close" });

    expect(dialog.kinds()).toEqual(["discard-composition", "menu"]);
    expect(dialog.state.composing).toBeUndefined();
    expect(dialog.state.broadcast!.parts[0]!.content).toEqual(text("Первое"));
  });

  it("chooses the replacement from saved posts", () => {
    const dialog = new Dialog({
      ...emptyAuthorState("menu"),
      actions: [{ kind: "replace-part", value: "0" }],
      broadcast: broadcast(),
    }).send({ kind: "callback", data: "author:menu:0" });
    expect(dialog.query("list-posts")).toEqual({
      kind: "list-posts",
      purpose: "library",
    });

    const post = {
      templateId: uuid(700),
      revision: 1,
      botIdentity: "inside",
      content: text("Сохранённый"),
    };
    dialog.send({
      kind: "posts-listed",
      purpose: "library",
      templates: [post],
      nextCursor: null,
    });
    expect(dialog.labels()).toEqual([
      "📝 Текст · Сохранённый",
      "Найти пост",
      "Создать сообщение",
      "Отмена",
    ]);

    dialog.click("📝 Текст · Сохранённый");
    expect(dialog.query("read-post")).toEqual({
      kind: "read-post",
      purpose: "library",
      templateId: uuid(700),
    });
    dialog.send({ kind: "post-read", purpose: "library", template: post });
    expect(dialog.state.composing!.content).toEqual(text("Сохранённый"));
    expect(dialog.state.composing!.destination.partId).toBe(uuid(901));
  });
});

describe("funnel", () => {
  it("lists saved funnels and unsaved drafts", () => {
    const dialog = new Dialog().send({ kind: "open" }).click("Воронки");
    expect(dialog.kinds()).toEqual(["retain-funnel-draft", "list-funnels"]);

    dialog.send({
      kind: "funnels-listed",
      items: [
        { id: uuid(800), name: "Прогрев", status: "edited" },
        { id: uuid(810), name: "Курс", status: "published" },
      ],
    });
    expect(dialog.labels()).toEqual([
      "Создать воронку",
      "Прогрев · есть правки",
      "Курс · Опубликована",
      "В меню",
    ]);
    expect(dialog.state.funnelAuthor).toEqual({});
  });

  it("creates a funnel whose first message arrives at entry", () => {
    const dialog = new Dialog({
      ...emptyAuthorState("menu"),
      actions: [{ kind: "f:new" }],
    }).send({ kind: "callback", data: "author:menu:0" });
    const funnelId = dialog.state.funnelAuthor!.funnel!.funnelId;
    expect(dialog.state.funnelAuthor!.prompt).toBeUndefined();

    dialog.write("Вход");
    expect(dialog.labels()).toEqual(["Сразу", "Не добавлять это сообщение"]);
    dialog.click("Сразу");
    const save = dialog.query("save-funnel");
    expect(save.funnel.name).toBe("Вход");
    expect(save.funnel.entryResponse.parts).toMatchObject([
      { content: text("Вход") },
    ]);

    dialog.send({
      kind: "funnel-saved",
      funnel: { ...save.funnel, revision: 1 },
      then: save.then,
    });
    expect(dialog.effects[0]).toEqual({
      kind: "discard-composition",
      id: funnelId,
    });
    expect(dialog.state.composing!.sequence).toEqual({
      lastOffset: 0,
      firstEntry: false,
    });
    expect(dialog.state.funnelAuthor!.dirty).toBe(false);
  });

  it("stops a sequence whose funnel the contract rejects", () => {
    const dialog = new Dialog({
      ...emptyAuthorState("menu"),
      funnelAuthor: { funnel: funnel() },
    });
    expect(() =>
      dialog.send({
        kind: "funnel-invalid",
        then: { kind: "next-message", destinationId: uuid(800) },
      }),
    ).toThrow("malformed");

    dialog.send({ kind: "funnel-invalid", then: { kind: "card" } });
    expect(dialog.menu!.text).toBe(
      "Добавьте хотя бы один пост в первый ответ и в каждый шаг, затем сохраните черновик.",
    );
  });

  it("pauses a published funnel and forgets its draft", () => {
    const dialog = new Dialog({
      ...emptyAuthorState("menu"),
      actions: [{ kind: "f:show" }],
      funnelAuthor: { funnel: funnel(), dirty: false },
    }).send({ kind: "callback", data: "author:menu:0" });
    expect(dialog.labels()).toEqual([
      "Добавить сообщение",
      "Применить изменения",
      "Сообщения",
      "Настройки",
      "Ещё →",
      "Все воронки",
    ]);

    dialog.click("Ещё →").click("Приостановить");
    expect(dialog.query("change-funnel")).toEqual({
      kind: "change-funnel",
      funnelId: uuid(800),
      revision: 2,
      action: "pause",
    });
    dialog.send({
      kind: "funnel-changed",
      funnel: funnel({ lifecycle: "paused", revision: 3 }),
    });
    expect(dialog.kinds()).toEqual(["remove-draft", "menu"]);
    expect(dialog.click("Ещё →").labels()).toContain("Продолжить");
  });

  it("previews publication only for the locked revision with valid materials", () => {
    const start = () =>
      new Dialog({
        ...emptyAuthorState("menu"),
        actions: [{ kind: "f:preview" }],
        funnelAuthor: { funnel: funnel(), dirty: false },
      }).send({ kind: "callback", data: "author:menu:0" });

    expect(start().query("lock-funnel")).toEqual({
      kind: "lock-funnel",
      funnelId: uuid(800),
      publish: false,
    });
    const changed = start();
    expect(() =>
      changed.send({ kind: "funnel-locked", publish: false, revision: 3 }),
    ).toThrow("revision_conflict");

    const dialog = start().send({
      kind: "funnel-locked",
      publish: false,
      revision: 2,
    });
    expect(dialog.query("validate-content").purpose).toBe("preview");

    const denied = start()
      .send({ kind: "funnel-locked", publish: false, revision: 2 })
      .send({
        kind: "content-validated",
        purpose: "preview",
        result: { status: "denied" },
      });
    expect(denied.menu!.text).toBe(
      "Право автора не подтверждено. Публикация недоступна.",
    );

    dialog.send({
      kind: "content-validated",
      purpose: "preview",
      result: { status: "ok", targetErrors: [] },
    });
    expect(dialog.query("publish-funnel")).toEqual({
      kind: "publish-funnel",
      funnelId: uuid(800),
      revision: 2,
      publish: false,
    });
    dialog.send({
      kind: "publication-previewed",
      preview: {
        funnelId: uuid(800),
        revision: 2,
        addedStepIds: [],
        editedStepIds: [],
        deletedStepIds: [],
        reorderedStepIds: [],
        eligibleContacts: 5,
        completedParticipantsReceivingNewSteps: 0,
        validationErrors: [],
      },
    });
    expect(dialog.labels()).toEqual(["Опубликовать воронку", "К воронке"]);
  });

  it("moves a delayed message to entry only when it was never published there", () => {
    const delayed = funnel({
      steps: [
        {
          stepId: uuid(803),
          delaySeconds: 3600,
          parts: [
            { partId: uuid(804), content: text("Урок") },
            { partId: uuid(805), content: text("Задание") },
          ],
        },
      ],
    });
    const start = () =>
      new Dialog({
        ...emptyAuthorState("menu"),
        actions: [{ kind: "f:timing-entry", id: uuid(804) }],
        funnelAuthor: { funnel: delayed, timingPartId: uuid(804) },
      }).send({ kind: "callback", data: "author:menu:0" });

    expect(start().query("read-part-history")).toEqual({
      kind: "read-part-history",
      funnelId: uuid(800),
      partId: uuid(804),
      delaySeconds: null,
    });

    const published = start().send({
      kind: "part-history-read",
      partId: uuid(804),
      delaySeconds: null,
      published: true,
    });
    expect(published.menu!.text).toContain("Его перенос изменил бы историю");
    expect(published.state.funnelAuthor!.funnel).toEqual(delayed);

    const moved = start().send({
      kind: "part-history-read",
      partId: uuid(804),
      delaySeconds: null,
      published: false,
    });
    const f = moved.state.funnelAuthor!.funnel!;
    expect(f.entryResponse.parts.map((p) => p.partId)).toEqual([
      uuid(802),
      uuid(804),
    ]);
    expect(f.steps[0]!.parts.map((p) => p.partId)).toEqual([uuid(805)]);
    expect(moved.state.funnelAuthor!.dirty).toBe(true);
    expect(moved.menu!.text).toContain("Прогрев · сообщения");
  });
});

describe("funnel settings", () => {
  function card(f: FunnelSnapshot = funnel(), dirty = false) {
    return new Dialog({
      ...emptyAuthorState("menu"),
      actions: [{ kind: "f:show" }],
      funnelAuthor: { funnel: f, dirty },
    }).send({ kind: "callback", data: "author:menu:0" });
  }

  it("opens settings and messages from the funnel card and returns to it", () => {
    const dialog = card();
    expect(dialog.labels()).toEqual([
      "Добавить сообщение",
      "Применить изменения",
      "Сообщения",
      "Настройки",
      "Ещё →",
      "Все воронки",
    ]);

    dialog.click("Настройки");
    expect(dialog.menu!.text).toBe("Настройки · Прогрев");
    expect(dialog.labels()).toEqual([
      "Название",
      "Первый ответ",
      "Шаги и задержки",
      "Источники",
      "Ещё →",
      "К воронке",
    ]);
    dialog.click("Ещё →");
    expect(dialog.labels()).toEqual([
      "Сделать основной",
      "Общий вводный блок",
      "← Предыдущие действия",
      "К воронке",
    ]);
    dialog.click("К воронке");
    expect(dialog.menu!.text).toContain("Прогрев\nОпубликована");

    dialog.click("Сообщения");
    expect(dialog.menu!.text).toContain("Прогрев · сообщения");
    dialog.click("К воронке");
    expect(dialog.labels()).toContain("Настройки");
  });

  it("restores an archived funnel from its settings", () => {
    const dialog = card(funnel({ lifecycle: "archived" }));
    expect(dialog.labels()).toEqual(["Настройки", "Все воронки"]);

    dialog.click("Настройки");
    expect(dialog.labels()).toEqual([
      "Восстановить",
      "Общий вводный блок",
      "К воронке",
    ]);
    dialog.click("Восстановить");
    expect(dialog.query("change-funnel")).toEqual({
      kind: "change-funnel",
      funnelId: uuid(800),
      revision: 2,
      action: "restore",
    });
  });

  const timed = () =>
    funnel({
      steps: [
        {
          stepId: uuid(803),
          delaySeconds: 3600,
          delayAnchor: "entry",
          parts: [{ partId: uuid(804), content: text("Урок") }],
        },
        {
          stepId: uuid(805),
          delaySeconds: 7200,
          delayAnchor: "entry",
          parts: [{ partId: uuid(806), content: text("Задание") }],
        },
      ],
    });
  const delays = (dialog: Dialog) =>
    dialog.state.funnelAuthor!.funnel!.steps.map((step) => [
      step.stepId,
      step.delaySeconds,
      step.delayAnchor,
    ]);

  it("keeps steps timed from entry in time order when the author edits them", () => {
    const dialog = card(timed()).click("Настройки").click("Шаги и задержки");
    expect(dialog.labels()).toEqual([
      "Шаг 1 · 1 ч от входа",
      "Шаг 2 · 2 ч от входа",
      "Добавить шаг",
      "К воронке",
    ]);

    dialog.click("Добавить шаг");
    const added = dialog.state.funnelAuthor!.target!;
    expect(dialog.menu!.text).toBe("Шаг 3\nЧерез 26 ч от входа\nСообщений: 0");
    expect(delays(dialog)).toEqual([
      [uuid(803), 3600, "entry"],
      [uuid(805), 7200, "entry"],
      [added, 93600, "entry"],
    ]);

    dialog.click("Задержка");
    expect(dialog.menu!.text).toContain("от входа");
    dialog.write("30 мин");
    expect(dialog.menu!.text).toBe(
      "Шаг 1\nЧерез 30 мин от входа\nСообщений: 0",
    );
    expect(delays(dialog)).toEqual([
      [added, 1800, "entry"],
      [uuid(803), 3600, "entry"],
      [uuid(805), 7200, "entry"],
    ]);

    dialog.click("Все шаги").click("Шаг 3 · 2 ч от входа").click("Поднять шаг");
    expect(delays(dialog)).toEqual([
      [added, 1800, "entry"],
      [uuid(805), 3600, "entry"],
      [uuid(803), 7200, "entry"],
    ]);

    dialog.click("Шаг 1 · 30 мин от входа").click("Убрать шаг");
    expect(delays(dialog)).toEqual([
      [uuid(805), 3600, "entry"],
      [uuid(803), 7200, "entry"],
    ]);
    expect(dialog.state.funnelAuthor!.dirty).toBe(true);
  });

  it("keeps a chain of steps timed after the previous one", () => {
    const chained = funnel({
      steps: timed().steps.map(({ stepId, delaySeconds, parts }) => ({
        stepId,
        delaySeconds,
        parts,
      })),
    });
    const dialog = card(chained).click("Настройки").click("Шаги и задержки");
    expect(dialog.labels()).toContain("Шаг 2 · 2 ч после предыдущего шага");

    dialog.click("Добавить шаг");
    const added = dialog.state.funnelAuthor!.target!;
    dialog.click("Задержка").write("30 мин");
    dialog.click("Все шаги").click("Шаг 3 · 30 мин после предыдущего шага");
    dialog.click("Поднять шаг");
    expect(delays(dialog)).toEqual([
      [uuid(803), 3600, undefined],
      [added, 1800, undefined],
      [uuid(805), 7200, undefined],
    ]);
  });

  it("times a message from entry and keeps the steps in time order", () => {
    const f = timed();
    const dialog = card(
      funnel({
        ...f,
        entryResponse: {
          ...f.entryResponse,
          parts: [
            ...f.entryResponse.parts,
            { partId: uuid(807), content: text("Бонус") },
          ],
        },
      }),
    ).click("Сообщения");
    expect(dialog.menu!.text).toBe(
      "Прогрев · сообщения\nВремя отсчитывается от входа. Выберите сообщение для настройки.",
    );
    expect(dialog.labels()).toEqual([
      "1. При входе · 📝 Текст · Вход",
      "2. При входе · 📝 Текст · Бонус",
      "3. Через 1 ч · 📝 Текст · Урок",
      "4. Через 2 ч · 📝 Текст · Задание",
      "Добавить сообщения",
      "К воронке",
    ]);

    dialog.click("4. Через 2 ч · 📝 Текст · Задание").click("Когда отправить");
    expect(dialog.menu!.text).toContain("от входа");
    dialog.write("30 мин");
    expect(delays(dialog)).toEqual([
      [uuid(805), 1800, "entry"],
      [uuid(803), 3600, "entry"],
    ]);

    dialog
      .click("2. При входе · 📝 Текст · Бонус")
      .click("Когда отправить")
      .write("90 мин");
    expect(dialog.query("read-part-history")).toMatchObject({
      partId: uuid(807),
      delaySeconds: 5400,
    });
    dialog.send({
      kind: "part-history-read",
      partId: uuid(807),
      delaySeconds: 5400,
      published: false,
    });
    const steps = dialog.state.funnelAuthor!.funnel!.steps;
    expect(steps.map((step) => [step.delaySeconds, step.delayAnchor])).toEqual([
      [1800, "entry"],
      [3600, "entry"],
      [5400, "entry"],
    ]);
    expect(steps[2]!.parts.map((p) => p.partId)).toEqual([uuid(807)]);
    expect(dialog.labels()).toContain("4. Через 90 мин · 📝 Текст · Бонус");
  });

  it("renames the funnel, sets it as the main one and manages its sources", () => {
    const dialog = card().click("Настройки").click("Название");
    dialog.write("Весенний прогрев");
    expect(dialog.menu!.text).toMatch(/^Весенний прогрев\n/);

    dialog.click("Настройки").click("Ещё →").click("Сделать основной");
    expect(dialog.state.funnelAuthor!.funnel!.isDefault).toBe(true);
    dialog.click("Настройки").click("Ещё →");
    expect(dialog.labels()).toContain("Убрать из основных");

    dialog.click("К воронке").click("Настройки").click("Источники");
    dialog.click("Добавить источник").write("Канал");
    dialog.write("m_x y");
    expect(dialog.menu!.text).toContain("Код должен начинаться с m_");
    dialog.write("m_channel");
    expect(dialog.labels()).toEqual([
      "Канал",
      "Добавить источник",
      "К воронке",
    ]);
    dialog.click("Канал");
    expect(dialog.menu!.text).toContain("?start=m_channel");
    dialog.click("Убрать источник");
    expect(dialog.state.funnelAuthor!.funnel!.sources).toEqual([]);

    dialog.click("К воронке").click("Сохранить черновик");
    const save = dialog.query("save-funnel");
    expect(save.funnel).toMatchObject({
      name: "Весенний прогрев",
      isDefault: true,
      sources: [],
    });
  });

  it("edits the first response and the shared intro", () => {
    const dialog = card().click("Настройки").click("Первый ответ");
    expect(dialog.menu!.text).toMatch(/^Первый ответ\n1\. /);
    expect(dialog.labels()).toContain("Добавить сохранённый пост");
    dialog.click("Сообщение 1").click("Убрать сообщение");
    expect(dialog.state.funnelAuthor!.funnel!.entryResponse.parts).toEqual([]);

    dialog.click("К воронке").click("Настройки").click("Ещё →");
    dialog.click("Общий вводный блок");
    expect(dialog.kinds()).toEqual(["retain-funnel-draft", "read-intro"]);
    const intro = {
      introId: uuid(700),
      revision: 1,
      parts: [{ partId: uuid(701), content: text("Привет") }],
    };
    dialog.send({
      kind: "intro-read",
      funnelAuthor: { intro, target: "intro", dirty: false },
    });
    expect(dialog.menu!.text).toMatch(/^Общий вводный блок\n1\. /);
    dialog.click("Сохранить общий блок");
    expect(dialog.query("validate-content")).toMatchObject({
      purpose: "intro",
      parts: intro.parts,
    });
    dialog.send({
      kind: "content-validated",
      purpose: "intro",
      result: { status: "ok", targetErrors: [] },
    });
    expect(dialog.query("save-intro")).toEqual({ kind: "save-intro", intro });
    dialog.send({ kind: "intro-saved", intro: { ...intro, revision: 2 } });
    expect(dialog.menu!.text).toContain("Общий вводный блок сохранён");
  });

  it("lists every step and source on one screen and every action of a middle step", () => {
    const steps = [1, 2, 3, 4, 5].map((n) => ({
      stepId: uuid(810 + n),
      delaySeconds: n * 3600,
      delayAnchor: "entry" as const,
      parts: [{ partId: uuid(820 + n), content: text(`Шаг ${n}`) }],
    }));
    const sources = [1, 2, 3, 4, 5].map((n) => ({
      sourceId: uuid(830 + n),
      code: `m_s${n}`,
      name: `Источник ${n}`,
    }));
    const dialog = card(funnel({ steps, sources }))
      .click("Настройки")
      .click("Шаги и задержки");
    expect(dialog.labels()).toHaveLength(7);

    dialog.click("Шаг 3 · 3 ч от входа");
    expect(dialog.labels()).toEqual([
      "Сообщения шага",
      "Задержка",
      "Поднять шаг",
      "Опустить шаг",
      "Убрать шаг",
      "Все шаги",
    ]);

    dialog.click("Все шаги").click("К воронке").click("Настройки");
    expect(dialog.click("Источники").labels()).toHaveLength(7);
  });
});
