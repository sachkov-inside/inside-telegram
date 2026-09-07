import {
  drafts,
  retainFunnelDraft,
  removeAuthorDraft,
  compositionButtons,
  discardComposition,
} from "./author-drafts.js";
import type { MessageDestination } from "./author-composer.js";
import type { TemplateContent } from "./communications-contract.js";
import { messageLabel, previewAuthorMessage } from "./author-message-view.js";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Action, Context } from "./author-admin.js";
import { authorRequest } from "./author-request.js";
import {
  AUTHOR_CONTENT_VALIDATION,
  type AuthorContentValidation,
} from "./author-content-validation.js";
import { enqueueAuthorMessage } from "./author-delivery.js";
import {
  CommunicationsError,
  validRequest,
} from "./communications-contract.js";
import { Funnels } from "./funnels.js";
import type {
  FunnelSnapshot,
  IntroSnapshot,
  MessagePart,
} from "./funnel-types.js";

type Buttons = [string, Action][];
type Reply = (text: string, buttons?: Buttons) => Promise<void>;
export interface AuthorFunnelState {
  funnel?: FunnelSnapshot;
  intro?: IntroSnapshot;
  dirty?: boolean;
  target?: "entry" | "intro" | string;
  replacePartId?: string;
  prompt?: "name" | "delay" | "source-name" | "source-code";
  sourceName?: string;
}
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

/** Funnel composition shares AuthorAdmin's session, authorization, update receipt and reply outbox. */
@Injectable()
export class AuthorFunnels {
  constructor(
    @Inject(Funnels) private readonly funnels: Funnels,
    @Inject(AUTHOR_CONTENT_VALIDATION)
    private readonly validation: AuthorContentValidation,
  ) {}
  private state(c: Context): AuthorFunnelState {
    return (c.state.funnelAuthor ??= {});
  }
  private request(
    c: Context,
    operation: string,
    payload: Parameters<typeof authorRequest>[2],
    revision = 0,
  ) {
    return authorRequest(c.accountRef, operation, payload, revision);
  }
  private async show(c: Context, reply: Reply): Promise<void> {
    const s = this.state(c);
    s.prompt = undefined;
    const f = s.funnel;
    if (!f) return this.perform(c, { kind: "f:list" }, reply);
    const editable = f.lifecycle !== "archived";
    return reply(
      `${f.name}\n${names[f.lifecycle]} · версия ${f.revision}${s.dirty ? " · есть несохранённые изменения" : ""}\nОбычный /start: ${f.isDefault ? "эта воронка после публикации" : "другая воронка"}\nПервый ответ: ${f.entryResponse.parts.length} сообщений\n${f.steps
        .slice(0, 20)
        .map(
          (step, i) =>
            `${i + 1}. Через ${formatFunnelDelay(step.delaySeconds)} после предыдущего · ${step.parts.length} сообщений`,
        )
        .join("\n")}\nИсточников: ${f.sources.length}`,
      [
        ...(await compositionButtons(c, f.funnelId)),
        ...(editable
          ? ([
              ["Название", { kind: "f:name" }],
              ["Первый ответ", { kind: "f:parts", id: "entry" }],
              ["Шаги и задержки", { kind: "f:steps" }],
              ["Источники", { kind: "f:sources" }],
              [
                f.isDefault ? "Убрать выбор для /start" : "Выбрать для /start",
                { kind: "f:default" },
              ],
              ["Сохранить черновик", { kind: "f:save" }],
              ["Проверить публикацию", { kind: "f:preview" }],
            ] as Buttons)
          : []),
        ...(!s.dirty && f.publishedRevision !== null
          ? ([
              ...(f.lifecycle === "published"
                ? ([
                    ["Приостановить", { kind: "f:life", value: "pause" }],
                  ] as Buttons)
                : []),
              ...(f.lifecycle === "paused"
                ? ([
                    ["Продолжить", { kind: "f:life", value: "resume" }],
                  ] as Buttons)
                : []),
              [
                f.lifecycle === "archived" ? "Восстановить" : "В архив",
                {
                  kind: "f:life",
                  value: f.lifecycle === "archived" ? "restore" : "archive",
                },
              ],
            ] as Buttons)
          : []),
        ...(s.dirty
          ? [
              ["Отказаться от правок", { kind: "f:discard" }] as [
                string,
                Action,
              ],
            ]
          : []),
        ["Общий вводный блок", { kind: "f:intro" }],
        ...root,
      ],
    );
  }
  private parts(s: AuthorFunnelState): readonly MessagePart[] {
    if (s.target === "intro") return s.intro?.parts ?? [];
    if (s.target === "entry") return s.funnel?.entryResponse.parts ?? [];
    return (
      s.funnel?.steps.find((step) => step.stepId === s.target)?.parts ?? []
    );
  }
  private replaceParts(s: AuthorFunnelState, parts: readonly MessagePart[]) {
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
  selectedParts(c: Context) {
    return this.parts(this.state(c));
  }
  async compose(
    c: Context,
    destination: Extract<MessageDestination, { kind: "funnel" }>,
    content: TemplateContent | undefined,
    reply: Reply,
  ) {
    const s = this.state(c);
    const id = s.target === "intro" ? s.intro?.introId : s.funnel?.funnelId;
    if (
      id !== destination.id ||
      s.target !== destination.target ||
      (s.funnel?.lifecycle === "archived" && s.target !== "intro")
    )
      throw new CommunicationsError("revision_conflict");
    if (content) {
      const parts = this.parts(s);
      if (
        destination.partId &&
        !parts.some((p) => p.partId === destination.partId)
      )
        throw new CommunicationsError("revision_conflict");
      if (
        !destination.partId &&
        parts.length >=
          (s.target === "intro" || s.target === "entry" ? 100 : 20)
      )
        throw new CommunicationsError("unsupported_content");
      this.replaceParts(
        s,
        destination.partId
          ? parts.map((p) =>
              p.partId === destination.partId ? { ...p, content } : p,
            )
          : [...parts, { partId: randomUUID(), content }],
      );
    }
    s.replacePartId = undefined;
    return this.partsMenu(c, reply);
  }
  private async partsMenu(c: Context, reply: Reply, offset = 0): Promise<void> {
    const s = this.state(c);
    const parts = this.parts(s);
    const title =
      s.target === "intro"
        ? "Общий вводный блок"
        : s.target === "entry"
          ? "Первый ответ"
          : "Сообщения шага";
    return reply(
      `${title}\n${
        parts
          .slice(offset, offset + 10)
          .map((p, i) => `${offset + i + 1}. ${messageLabel(p.content, 100)}`)
          .join("\n") || "Добавьте сохранённый пост."
      }\nВыбранное содержимое сохраняется отдельно от исходного поста.${s.target === "intro" ? " После сохранения новые получатели увидят этот блок; прежним он повторно не придёт." : ""}`,
      [
        ...(await compositionButtons(
          c,
          (s.target === "intro" ? s.intro?.introId : s.funnel?.funnelId)!,
        )),
        ...parts
          .slice(offset, offset + 10)
          .map((part, i): [string, Action] => [
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
        ...(parts.length > offset + 10
          ? ([
              [
                "Следующие сообщения",
                { kind: "f:parts-page", value: String(offset + 10) },
              ],
            ] as Buttons)
          : []),
        ["Создать сообщение", { kind: "compose:funnel" }],
        ["Добавить сохранённый пост", { kind: "f:posts" }],
        ...(parts.length
          ? ([["Образцы себе", { kind: "f:sample" }]] as Buttons)
          : []),
        ...(s.target === "intro"
          ? ([
              ["Сохранить общий блок", { kind: "f:save-intro" }],
              ...root,
            ] as Buttons)
          : back),
      ],
    );
  }
  async act(c: Context, a: Action, reply: Reply): Promise<void> {
    await sql`savepoint author_funnel_action`.execute(c.tx);
    try {
      await this.perform(c, a, reply);
      await sql`release savepoint author_funnel_action`.execute(c.tx);
    } catch (error) {
      await sql`rollback to savepoint author_funnel_action`.execute(c.tx);
      throw error;
    }
  }
  private async perform(c: Context, a: Action, reply: Reply): Promise<void> {
    const s = this.state(c);
    c.state.prompt = undefined;
    s.prompt = undefined;
    if (["f:list", "f:intro", "f:read", "f:new"].includes(a.kind))
      await retainFunnelDraft(c);
    if (a.kind === "f:discard") {
      const id = s.target === "intro" ? s.intro?.introId : s.funnel?.funnelId;
      if (id) {
        await removeAuthorDraft(c, id);
        await discardComposition(c, id);
      }
      c.state.funnelAuthor = {};
      return this.perform(c, { kind: "f:list" }, reply);
    }
    if (a.kind === "f:list") {
      let saved = c.tx
        .selectFrom("communication_funnels")
        .select("funnel_id as id")
        .where("bot_identity", "=", c.input.botIdentity)
        .where("owner_account_ref", "=", c.accountRef);
      let scratch = c.tx
        .selectFrom("communication_author_drafts")
        .select("draft_id as id")
        .where("bot_identity", "=", c.input.botIdentity)
        .where("owner_account_ref", "=", c.accountRef)
        .where("kind", "=", "funnel");
      if (a.id) {
        saved = saved.where("funnel_id", ">", a.id);
        scratch = scratch.where("draft_id", ">", a.id);
      }
      const ids = await saved.union(scratch).orderBy("id").limit(11).execute();
      const items: [string, Action][] = [];
      for (const { id } of ids.slice(0, 10)) {
        const draft = await drafts(c)
          .where("draft_id", "=", id)
          .executeTakeFirst();
        if (draft)
          items.push([
            `${draft.name.slice(0, 40)} · есть правки`,
            { kind: "f:read", id },
          ]);
        else {
          const result = await this.funnels.execute(
            this.request(c, "funnels.read", { funnelId: id }),
            c.tx,
          );
          if ("funnel" in result)
            items.push([
              `${result.funnel.name.slice(0, 40)} · ${names[result.funnel.lifecycle]}`,
              { kind: "f:read", id },
            ]);
        }
      }
      c.state.funnelAuthor = {};
      return reply("Воронки · черновики сохраняются при каждом действии", [
        ["Создать воронку", { kind: "f:new" }],
        ["Общий вводный блок", { kind: "f:intro" }],
        ...items,
        ...(ids.length > 10
          ? [
              ["Следующие воронки", { kind: "f:list", id: ids[9]!.id }] as [
                string,
                Action,
              ],
            ]
          : []),
        ["В меню", { kind: "home" }],
      ]);
    }
    if (a.kind === "f:new") {
      c.state.funnelAuthor = {
        funnel: {
          funnelId: randomUUID(),
          name: "Новая воронка",
          isDefault: false,
          entryResponse: { stepId: randomUUID(), parts: [] },
          steps: [],
          sources: [],
          revision: 0,
          publishedRevision: null,
          lifecycle: "draft",
        },
        dirty: true,
        prompt: "name",
      };
      return reply("Напишите название воронки (до 128 символов).", back);
    }
    if (a.kind === "f:read") {
      const draft = await drafts(c)
        .where("draft_id", "=", a.id!)
        .where("kind", "=", "funnel")
        .executeTakeFirst();
      if (draft?.snapshot) {
        c.state.funnelAuthor = draft.snapshot as AuthorFunnelState;
        return this.show(c, reply);
      }
      const result = await this.funnels.execute(
        this.request(c, "funnels.read", { funnelId: a.id! }),
        c.tx,
      );
      if (!("funnel" in result)) throw new CommunicationsError("malformed");
      c.state.funnelAuthor = { funnel: result.funnel, dirty: false };
      return this.show(c, reply);
    }
    if (a.kind === "f:show") return this.show(c, reply);
    if (a.kind === "f:intro") {
      const draft = await drafts(c)
        .where("kind", "=", "intro")
        .executeTakeFirst();
      if (draft?.snapshot) {
        c.state.funnelAuthor = draft.snapshot as AuthorFunnelState;
        return this.partsMenu(c, reply);
      }
      // Intro edits have their own scratch snapshot; navigation explicitly leaves a funnel draft.
      let intro: IntroSnapshot;
      try {
        const result = await this.funnels.execute(
          this.request(c, "intro.read", {}),
          c.tx,
        );
        if (!("intro" in result)) throw new CommunicationsError("malformed");
        intro = result.intro;
      } catch (error) {
        if (
          !(error instanceof CommunicationsError) ||
          error.code !== "not_found"
        )
          throw error;
        intro = { introId: randomUUID(), revision: 0, parts: [] };
      }
      c.state.funnelAuthor = { intro, target: "intro", dirty: false };
      return this.partsMenu(c, reply);
    }
    if (a.kind === "f:parts") {
      s.target = a.id;
      s.replacePartId = undefined;
      return this.partsMenu(c, reply);
    }
    if (a.kind === "f:parts-page")
      return this.partsMenu(c, reply, Number(a.value));
    if (a.kind === "f:part") {
      const parts = this.parts(s);
      const index = parts.findIndex((p) => p.partId === a.id);
      const part = parts[index];
      if (!part) throw new CommunicationsError("not_found");
      await previewAuthorMessage(c, part.content);
      return reply(
        `Сообщение ${index + 1} · ${part.content.type}\n${part.content.text.slice(0, 1000)}\nКнопок: ${part.content.buttons.length}`,
        [
          [
            "Изменить сообщение и кнопки",
            { kind: "compose:edit-funnel", id: part.partId },
          ],
          ["Заменить из сохранённых", { kind: "f:posts", value: part.partId }],
          ...(index > 0
            ? ([
                ["Выше", { kind: "f:move-part", id: part.partId, value: "-1" }],
              ] as Buttons)
            : []),
          ...(index < parts.length - 1
            ? ([
                ["Ниже", { kind: "f:move-part", id: part.partId, value: "1" }],
              ] as Buttons)
            : []),
          ["Убрать сообщение", { kind: "f:remove-part", id: part.partId }],
          ["К сообщениям", { kind: "f:parts-page", value: "0" }],
        ],
      );
    }
    if (a.kind === "f:move-part" || a.kind === "f:remove-part") {
      const parts = [...this.parts(s)];
      const index = parts.findIndex((p) => p.partId === a.id);
      if (index < 0) throw new CommunicationsError("not_found");
      if (a.kind === "f:remove-part") parts.splice(index, 1);
      else {
        const next = index + Number(a.value);
        if (next >= 0 && next < parts.length)
          [parts[index], parts[next]] = [parts[next]!, parts[index]!];
      }
      this.replaceParts(s, parts);
      return this.partsMenu(c, reply);
    }
    if (a.kind === "f:sample") {
      for (const part of this.parts(s))
        await enqueueAuthorMessage(c.tx, {
          deliveryId: randomUUID(),
          botIdentity: c.input.botIdentity,
          accountRef: c.accountRef,
          telegramUserId: c.input.telegramUserId,
          telegramIdentityRef: c.identityRef,
          message: { chatId: c.input.telegramUserId, content: part.content },
        });
      return reply(
        "Образцы выбранных сообщений поставлены в очередь только вам.",
        [["К сообщениям", { kind: "f:parts-page", value: "0" }]],
      );
    }
    if (a.kind === "f:save-intro" && s.intro) {
      if (!s.intro.parts.length)
        return reply("Добавьте хотя бы один сохранённый пост.", [
          ["К сообщениям", { kind: "f:parts-page", value: "0" }],
        ]);
      const validation = await this.validation.validate(
        {
          kind: "telegram",
          accountRef: c.accountRef,
          telegramIdentityRef: c.identityRef,
          botIdentity: c.input.botIdentity,
        },
        s.intro.parts,
      );
      if (validation.status !== "ok" || validation.targetErrors.length)
        return reply(
          "Общий блок не сохранён: проверка материалов недоступна или ссылки ведут на недоступные материалы.",
          [["К сообщениям", { kind: "f:parts-page", value: "0" }]],
        );
      const result = await this.funnels.execute(
        this.request(
          c,
          "intro.save",
          { introId: s.intro.introId, parts: s.intro.parts },
          s.intro.revision,
        ),
        c.tx,
      );
      if ("intro" in result) s.intro = result.intro;
      s.dirty = false;
      return reply(
        "Общий вводный блок сохранён для будущих получателей. Уже получившим его повторной отправки не будет.",
        root,
      );
    }
    const f = s.funnel;
    if (!f) return reply("Сначала откройте воронку.", root);
    if (f.lifecycle === "archived" && a.kind !== "f:life")
      return this.show(c, reply);
    if (a.kind === "f:name") {
      s.prompt = "name";
      return reply("Напишите название воронки (до 128 символов).", back);
    }
    if (a.kind === "f:default") {
      s.funnel = { ...f, isDefault: !f.isDefault };
      s.dirty = true;
      return this.show(c, reply);
    }
    if (a.kind === "f:steps") {
      const offset = Number(a.value ?? 0);
      return reply(
        "Шаги идут по порядку. Задержка отсчитывается после завершения предыдущего шага.",
        [
          ...f.steps
            .slice(offset, offset + 15)
            .map((step, i): [string, Action] => [
              `Шаг ${offset + i + 1} · ${formatFunnelDelay(step.delaySeconds)}`,
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
    if (a.kind === "f:add-step") {
      if (f.steps.length >= 100)
        return reply("В воронке может быть до 100 шагов.", back);
      const step = { stepId: randomUUID(), delaySeconds: 86400, parts: [] };
      s.funnel = { ...f, steps: [...f.steps, step] };
      s.dirty = true;
      return this.perform(c, { kind: "f:step", id: step.stepId }, reply);
    }
    if (a.kind === "f:step") {
      const index = f.steps.findIndex((step) => step.stepId === a.id);
      const step = f.steps[index];
      if (!step) throw new CommunicationsError("not_found");
      s.target = step.stepId;
      return reply(
        `Шаг ${index + 1}\nЧерез ${formatFunnelDelay(step.delaySeconds)} после предыдущего\nСообщений: ${step.parts.length}`,
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
          ...back,
        ],
      );
    }
    if (a.kind === "f:delay") {
      s.prompt = "delay";
      return reply(
        "Напишите задержку: 30 мин, 2 ч, 1 д или 0 для отправки сразу после предыдущего шага.",
        back,
      );
    }
    if (a.kind === "f:move-step" || a.kind === "f:remove-step") {
      const steps = [...f.steps];
      const index = steps.findIndex((step) => step.stepId === a.id);
      if (index < 0) throw new CommunicationsError("not_found");
      if (a.kind === "f:remove-step") steps.splice(index, 1);
      else {
        const next = index + Number(a.value);
        if (next >= 0 && next < steps.length)
          [steps[index], steps[next]] = [steps[next]!, steps[index]!];
      }
      s.funnel = { ...f, steps };
      s.dirty = true;
      return this.perform(c, { kind: "f:steps" }, reply);
    }
    if (a.kind === "f:sources") {
      const offset = Number(a.value ?? 0);
      return reply(
        "Источники входа. Код применяется после публикации. Ссылка бота должна содержать ?start=код.",
        [
          ...f.sources
            .slice(offset, offset + 15)
            .map((source): [string, Action] => [
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
    if (a.kind === "f:source") {
      const source = f.sources.find((item) => item.sourceId === a.id);
      if (!source) throw new CommunicationsError("not_found");
      return reply(
        `${source.name}\nКод: ${source.code}\nПараметр ссылки: ?start=${source.code}`,
        [
          ["Убрать источник", { kind: "f:remove-source", id: source.sourceId }],
          ["Все источники", { kind: "f:sources" }],
        ],
      );
    }
    if (a.kind === "f:add-source") {
      if (f.sources.length >= 100)
        return reply("В воронке может быть до 100 источников.", back);
      s.prompt = "source-name";
      return reply(
        "Как назвать источник? Например: канал или описание видео.",
        back,
      );
    }
    if (a.kind === "f:remove-source") {
      s.funnel = {
        ...f,
        sources: f.sources.filter((item) => item.sourceId !== a.id),
      };
      s.dirty = true;
      return this.perform(c, { kind: "f:sources" }, reply);
    }
    if (a.kind === "f:save") {
      const request = this.request(
        c,
        "funnels.save",
        {
          funnelId: f.funnelId,
          name: f.name,
          isDefault: f.isDefault,
          sources: f.sources,
          entryResponse: f.entryResponse,
          steps: f.steps,
        },
        f.revision,
      );
      if (!validRequest(request))
        return reply(
          "Добавьте хотя бы один пост в первый ответ и в каждый шаг, затем сохраните черновик.",
          back,
        );
      const result = await this.funnels.execute(request, c.tx);
      if ("funnel" in result) s.funnel = result.funnel;
      s.dirty = false;
      return this.show(c, reply);
    }
    if (a.kind === "f:preview" || a.kind === "f:publish") {
      if (s.dirty || !f.revision)
        return reply(
          "Сначала сохраните черновик. Проверка и публикация относятся к сохранённой версии.",
          back,
        );
      // Read locks definition changes through this transaction. Validate precisely the same revision.
      const loaded = await this.funnels.execute(
        this.request(c, "funnels.read", { funnelId: f.funnelId }),
        c.tx,
      );
      if (!("funnel" in loaded) || loaded.funnel.revision !== f.revision)
        throw new CommunicationsError("revision_conflict");
      const result = await this.validation.validate(
        {
          kind: "telegram",
          accountRef: c.accountRef,
          telegramIdentityRef: c.identityRef,
          botIdentity: c.input.botIdentity,
        },
        [...f.entryResponse.parts, ...f.steps.flatMap((step) => step.parts)],
      );
      if (result.status !== "ok")
        return reply(
          result.status === "denied"
            ? "Право автора не подтверждено. Публикация недоступна."
            : "Не удалось проверить материалы в Platform. Попробуйте проверку позже; публикации не было.",
          back,
        );
      if (result.targetErrors.length)
        return reply(
          `Публикация недоступна. Исправьте ссылки в выбранных постах:\n${result.targetErrors
            .slice(0, 10)
            .map(
              (error) =>
                `${error.url.slice(0, 200)} — ${{ not_found: "не найдено", not_published: "не опубликовано", not_free: "нет бесплатного доступа", incomplete: "серия не готова" }[error.reason]}`,
            )
            .join("\n")}`,
          back,
        );
      const output = await this.funnels.execute(
        this.request(
          c,
          a.kind === "f:publish" ? "funnels.publish" : "funnels.preview",
          { funnelId: f.funnelId },
          f.revision,
        ),
        c.tx,
      );
      if ("funnel" in output) {
        s.funnel = output.funnel;
        return this.show(c, reply);
      }
      if (!("preview" in output)) throw new CommunicationsError("malformed");
      const p = output.preview;
      return reply(
        `Публикация версии ${p.revision}\nНовых шагов: ${p.addedStepIds.length}\nИзменённых: ${p.editedStepIds.length}\nУдалённых: ${p.deletedStepIds.length}\nПорядок изменён: ${p.reorderedStepIds.length}\nПолучателей продолжения: ${p.eligibleContacts}\nИз них уже завершили прежнюю воронку: ${p.completedParticipantsReceivingNewSteps}\nУже доставленное повторно не отправляется.`,
        [["Опубликовать воронку", { kind: "f:publish" }], ...back],
      );
    }
    if (a.kind === "f:life" && !s.dirty) {
      const result = await this.funnels.execute(
        this.request(
          c,
          "funnels.lifecycle",
          {
            funnelId: f.funnelId,
            action: a.value as "pause" | "resume" | "archive" | "restore",
          },
          f.revision,
        ),
        c.tx,
      );
      if ("funnel" in result) s.funnel = result.funnel;
      return this.show(c, reply);
    }
    return this.show(c, reply);
  }
  async answer(c: Context, reply: Reply): Promise<void> {
    const s = this.state(c);
    const f = s.funnel;
    const text = c.input.text.trim();
    if (!f) return reply("Откройте воронку заново.", root);
    if (s.prompt === "name" || s.prompt === "source-name") {
      if (!text || text.length > 128)
        return reply("Нужно от 1 до 128 символов.", back);
      if (s.prompt === "source-name") {
        s.sourceName = text;
        s.prompt = "source-code";
        return reply(
          "Напишите уникальный код: m_ и от 1 до 40 латинских букв, цифр, _ или -. Например m_youtube.",
          back,
        );
      }
      s.funnel = { ...f, name: text };
      s.dirty = true;
      return this.show(c, reply);
    }
    if (s.prompt === "source-code") {
      if (
        !/^m_[A-Za-z0-9_-]{1,40}$/.test(text) ||
        f.sources.some((source) => source.code === text)
      )
        return reply(
          "Код должен начинаться с m_ и быть уникальным. После префикса — от 1 до 40 латинских букв, цифр, _ или -.",
          back,
        );
      s.funnel = {
        ...f,
        sources: [
          ...f.sources,
          { sourceId: randomUUID(), name: s.sourceName!, code: text },
        ],
      };
      s.dirty = true;
      return this.perform(c, { kind: "f:sources" }, reply);
    }
    if (s.prompt === "delay") {
      const delaySeconds = parseFunnelDelay(text);
      if (delaySeconds === undefined)
        return reply(
          "Не удалось понять задержку. Примеры: 30 мин, 2 ч, 1 д, 0.",
          back,
        );
      s.funnel = {
        ...f,
        steps: f.steps.map((step) =>
          step.stepId === s.target ? { ...step, delaySeconds } : step,
        ),
      };
      s.dirty = true;
      return this.perform(c, { kind: "f:step", id: s.target }, reply);
    }
    return this.show(c, reply);
  }
}

export function parseFunnelDelay(value: string): number | undefined {
  const match = /^(\d+)\s*(с|сек|мин|м|ч|час|д|дн)?$/iu.exec(value.trim());
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
    Number(match[1]) * (factors[match[2]?.toLowerCase() ?? "с"] ?? 1);
  return Number.isSafeInteger(seconds) && seconds <= 2147483647
    ? seconds
    : undefined;
}
function formatFunnelDelay(seconds: number): string {
  for (const [unit, factor] of [
    ["д", 86400],
    ["ч", 3600],
    ["мин", 60],
  ] as const)
    if (seconds > 0 && seconds % factor === 0)
      return `${seconds / factor} ${unit}`;
  return `${seconds} с`;
}
