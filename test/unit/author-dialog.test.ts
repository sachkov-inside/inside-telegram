import { describe, expect, it } from "vitest";
import {
  AUTHOR_STATE_VERSION,
  emptyAuthorState,
  pageAuthorMenu,
  parseAuthorState,
  resolveAuthorCallback,
  type AuthorAction,
  type AuthorState,
} from "../../src/modules/communications/author-dialog.js";
import type { TemplateContent } from "../../src/modules/communications/communications-contract.js";

const broadcastId = "4f7c1d2e-9a8b-4c3d-8e7f-6a5b4c3d2e1f";

function stateWith(actions: AuthorAction[]): AuthorState {
  return { ...emptyAuthorState("menu-token"), actions };
}

describe("author callback navigation", () => {
  const state = stateWith([
    { kind: "broadcasts" },
    { kind: "read-broadcast", id: broadcastId },
  ]);

  it("opens the action the author saw in the current menu", () => {
    expect(resolveAuthorCallback(state, "author:menu-token:1")).toEqual({
      kind: "read-broadcast",
      id: broadcastId,
    });
  });

  it("rejects a button from an older menu or outside the menu", () => {
    expect(resolveAuthorCallback(state, "author:old-token:0")).toBeUndefined();
    expect(resolveAuthorCallback(state, "author:menu-token:2")).toBeUndefined();
    expect(
      resolveAuthorCallback(state, "author:menu-token:first"),
    ).toBeUndefined();
  });

  it("keeps the permanent home, broadcast list and broadcast links working", () => {
    const stale = stateWith([]);
    expect(resolveAuthorCallback(stale, "author:home:0")).toEqual({
      kind: "home",
    });
    expect(resolveAuthorCallback(stale, "author:broadcasts:0")).toEqual({
      kind: "broadcasts",
    });
    expect(
      resolveAuthorCallback(stale, `author:open-broadcast:${broadcastId}`),
    ).toEqual({ kind: "read-broadcast", id: broadcastId });
    expect(
      resolveAuthorCallback(stale, "author:open-broadcast:not-a-broadcast"),
    ).toBeUndefined();
    expect(resolveAuthorCallback(stale, "author:home:1")).toBeUndefined();
  });
});

describe("author menu pages", () => {
  const options = Array.from(
    { length: 9 },
    (_, index): [string, AuthorAction] => [
      `Пост ${index + 1}`,
      { kind: "remove-button", value: String(index) },
    ],
  );
  const back: [string, AuthorAction] = ["В меню", { kind: "home" }];

  it("shows a short menu whole", () => {
    const buttons = [...options.slice(0, 5), back];
    expect(pageAuthorMenu({ text: "Меню", buttons }, 0)).toEqual(buttons);
  });

  it("splits a long menu into pages of four and keeps the way back", () => {
    const menu = { text: "Меню", buttons: [...options, back] };

    expect(pageAuthorMenu(menu, 0).map(([label]) => label)).toEqual([
      "Пост 1",
      "Пост 2",
      "Пост 3",
      "Пост 4",
      "Ещё →",
      "В меню",
    ]);
    expect(pageAuthorMenu(menu, 2).map(([label]) => label)).toEqual([
      "Пост 9",
      "← Предыдущие действия",
      "В меню",
    ]);
    expect(pageAuthorMenu(menu, 1)).toContainEqual([
      "Ещё →",
      { kind: "menu:page", value: "2" },
    ]);
  });

  it("never pages a list of choices", () => {
    const buttons = [
      ...options.map(([label], index): [string, AuthorAction] => [
        label,
        { kind: "read-post", id: `post-${index}` },
      ]),
      back,
    ];
    expect(pageAuthorMenu({ text: "Посты", buttons }, 0)).toEqual(buttons);
  });
});

describe("stored author session", () => {
  it("restores a session saved by the current version", () => {
    const state: AuthorState = {
      ...stateWith([{ kind: "f:list" }, { kind: "home" }]),
      menu: { text: "Воронки", buttons: [["В меню", { kind: "home" }]] },
      prompt: { kind: "button-url", buttonTitle: "Купить" },
      batch: "broadcast",
      pendingSchedule: null,
    };

    expect(parseAuthorState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("resets a session whose shape the current version cannot trust", () => {
    const current = JSON.parse(JSON.stringify(stateWith([{ kind: "home" }])));
    for (const stored of [
      null,
      "state",
      { ...current, version: AUTHOR_STATE_VERSION + 1 },
      { ...current, actions: [{ kind: "drop-database" }] },
      { ...current, actions: [{ kind: "read-post", id: 7 }] },
      { ...current, menu: { text: "Меню", buttons: [["В меню"]] } },
      { ...current, prompt: { kind: "button-url" } },
      { ...current, batch: "funnels" },
      { ...current, token: undefined },
      { ...current, composing: { destination: { kind: "post", id: "p" } } },
    ])
      expect(parseAuthorState(stored), JSON.stringify(stored)).toBeUndefined();
  });

  it("trusts only buttons that carry the data their kind needs", () => {
    const current = JSON.parse(JSON.stringify(stateWith([])));
    for (const actions of [
      [{ kind: "read-post" }],
      [{ kind: "f:message", id: "part" }],
      [{ kind: "f:life", value: "delete" }],
      [{ kind: "menu:page", value: 1 }],
      [{ kind: "posts", id: 7 }],
    ])
      expect(
        parseAuthorState({ ...current, actions }),
        JSON.stringify(actions),
      ).toBeUndefined();
    const valid: AuthorAction[] = [
      { kind: "posts" },
      { kind: "posts", id: "cursor" },
      { kind: "f:message", id: "part", value: "entry" },
      { kind: "f:life", value: "archive" },
    ];
    expect(parseAuthorState({ ...current, actions: valid })?.actions).toEqual(
      valid,
    );
    const typed: AuthorAction[] = [
      // @ts-expect-error A post link names its post.
      { kind: "read-post" },
      // @ts-expect-error Home carries no selection.
      { kind: "home", id: "post" },
      // @ts-expect-error A lifecycle button names one of the known changes.
      { kind: "f:life", value: "delete" },
    ];
    expect(typed).toHaveLength(3);
  });

  it("checks the nested snapshots of a stored session", () => {
    const content: TemplateContent = {
      type: "text",
      text: "Пост",
      entities: [],
      buttons: [],
    };
    const part = { partId: broadcastId, content };
    const nested: AuthorState = {
      ...stateWith([]),
      composing: {
        destination: {
          kind: "funnel",
          id: broadcastId,
          target: "entry",
          expectedRevision: 1,
        },
        sequence: { lastOffset: 0, firstEntry: true },
        content,
      },
      funnelAuthor: {
        funnel: {
          funnelId: broadcastId,
          name: "Новая воронка",
          isDefault: false,
          entryResponse: { stepId: broadcastId, parts: [part] },
          steps: [{ stepId: broadcastId, delaySeconds: 60, parts: [] }],
          sources: [],
          revision: 0,
          publishedRevision: null,
          lifecycle: "draft",
        },
        dirty: true,
        target: "entry",
      },
      broadcast: {
        broadcastId,
        revision: 0,
        state: "draft",
        parts: [{ ...part, sendAfterSeconds: 60 }],
        audience: { kind: "all" },
        scheduledAt: null,
        audienceSnapshotId: null,
        snapshotSize: 0,
      },
      template: {
        templateId: broadcastId,
        revision: 1,
        botIdentity: "inside",
        content,
      },
    };
    const stored = JSON.parse(JSON.stringify(nested));
    expect(parseAuthorState(stored)).toEqual(nested);

    const changed = (edit: (copy: typeof stored) => void) => {
      const copy = structuredClone(stored);
      edit(copy);
      return copy;
    };
    for (const untrusted of [
      changed((s) => (s.composing.content = { type: "sticker" })),
      changed((s) => (s.composing.sequence = { lastOffset: "0" })),
      changed((s) => (s.composing.destination.expectedRevision = "1")),
      changed((s) => (s.funnelAuthor.funnel.steps[0].parts = [{ partId: 1 }])),
      changed((s) => (s.funnelAuthor.funnel.lifecycle = "deleted")),
      changed((s) => (s.funnelAuthor.funnel.sources = [{ code: "x" }])),
      changed((s) => (s.funnelAuthor.prompt = "title")),
      changed((s) => (s.broadcast.parts[0].partId = "not-an-id")),
      changed((s) => (s.broadcast.audience = { kind: "funnels" })),
      changed((s) => delete s.template.botIdentity),
    ])
      expect(parseAuthorState(untrusted)).toBeUndefined();
  });

  it("upgrades a session saved before states were versioned", () => {
    expect(
      parseAuthorState({
        token: "menu-token",
        actions: [{ kind: "home" }],
        prompt: "button-url",
        buttonTitle: "Купить",
      }),
    ).toEqual({
      ...stateWith([{ kind: "home" }]),
      prompt: { kind: "button-url", buttonTitle: "Купить" },
    });
    expect(
      parseAuthorState({
        token: "menu-token",
        actions: [],
        prompt: "schedule",
      }),
    ).toEqual({ ...stateWith([]), prompt: { kind: "schedule" } });
  });
});
