import { randomUUID } from "node:crypto";
import type { ComposerState } from "./author-composer.js";
import type { AuthorFunnelState } from "./author-funnels.js";
import type { broadcastView } from "./broadcasts.js";
import type { TemplateSnapshot } from "./communications-contract.js";

/**
 * Every button of the author admin dialog. A menu stores the actions it showed, so a persisted
 * session may only contain kinds from this list.
 */
const AUTHOR_ACTION_KINDS = [
  "apply-schedule",
  "batch:broadcast",
  "batch:done",
  "batch:funnel",
  "broadcast-sample",
  "broadcasts",
  "button",
  "cancel",
  "confirm-cancel",
  "confirm-launch",
  "copy-broadcast",
  "create-broadcast",
  "home",
  "launch",
  "menu:page",
  "move-part",
  "new",
  "new-broadcast",
  "overview",
  "parts",
  "pause",
  "pick-part",
  "post-search",
  "posts",
  "posts-all",
  "read-broadcast",
  "read-post",
  "remove-button",
  "remove-part",
  "rename-broadcast",
  "replace",
  "replace-part",
  "resume",
  "sample",
  "schedule",
  "send-now",
  "send-options",
  "show-part",
  "statistics",
  "compose:accept",
  "compose:all",
  "compose:broadcast",
  "compose:button",
  "compose:cancel",
  "compose:choose",
  "compose:discard",
  "compose:edit-broadcast",
  "compose:edit-funnel",
  "compose:funnel",
  "compose:library",
  "compose:preview",
  "compose:remove-button",
  "compose:replace",
  "compose:resume",
  "compose:search",
  "sequence:broadcast",
  "sequence:discard",
  "sequence:done",
  "sequence:funnel",
  "sequence:time",
  "f:add-source",
  "f:add-step",
  "f:confirm-archive",
  "f:default",
  "f:delay",
  "f:discard",
  "f:intro",
  "f:life",
  "f:list",
  "f:message",
  "f:messages",
  "f:move-part",
  "f:move-step",
  "f:name",
  "f:new",
  "f:part",
  "f:parts",
  "f:parts-page",
  "f:posts",
  "f:preview",
  "f:publish",
  "f:read",
  "f:remove-part",
  "f:remove-source",
  "f:remove-step",
  "f:sample",
  "f:save",
  "f:save-intro",
  "f:settings",
  "f:show",
  "f:source",
  "f:sources",
  "f:step",
  "f:steps",
  "f:timing",
  "f:timing-entry",
] as const;

export type AuthorActionKind = (typeof AUTHOR_ACTION_KINDS)[number];

/** One button's action: its kind names the handler, `id` and `value` carry the selection. */
export type AuthorAction = {
  [Kind in AuthorActionKind]: {
    readonly kind: Kind;
    readonly id?: string;
    readonly value?: string;
  };
}[AuthorActionKind];

export type ComposeAction = Extract<
  AuthorAction,
  { kind: `compose:${string}` }
>;
export type SequenceAction = Extract<
  AuthorAction,
  { kind: `sequence:${string}` }
>;
export type FunnelAction = Extract<AuthorAction, { kind: `f:${string}` }>;

export type AuthorButton = [label: string, action: AuthorAction];

export interface AuthorMenu {
  text: string;
  buttons: AuthorButton[];
}

/** The text the dialog waits for from the author outside a composer or funnel prompt. */
export type AuthorPrompt =
  | { readonly kind: "capture" }
  | { readonly kind: "replace" }
  | { readonly kind: "button-title" }
  | { readonly kind: "button-url"; readonly buttonTitle: string }
  | { readonly kind: "schedule" }
  | { readonly kind: "broadcast-name" }
  | { readonly kind: "post-search" };

/** Versions 0 and 1 differ only in the prompt; a session without a version is version 0. */
export const AUTHOR_STATE_VERSION = 1;

export interface AuthorState {
  version: typeof AUTHOR_STATE_VERSION;
  /** Identifies the latest menu; a callback from another menu is stale. */
  token: string;
  /** The actions of the latest menu's buttons, by position. */
  actions: AuthorAction[];
  freshMenu?: boolean;
  batch?: "broadcast" | "funnel";
  menu?: AuthorMenu;
  composing?: ComposerState;
  broadcastName?: string;
  pendingSchedule?: string | null;
  libraryQuery?: string;
  funnelAuthor?: AuthorFunnelState;
  template?: TemplateSnapshot;
  broadcast?: ReturnType<typeof broadcastView>;
  prompt?: AuthorPrompt;
  replacePart?: { broadcastId: string; partId: string };
}

export function emptyAuthorState(): AuthorState {
  return { version: AUTHOR_STATE_VERSION, token: randomUUID(), actions: [] };
}

const BROADCAST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves `author:<token>:<index>` against the menu the author saw. Home, the broadcast list
 * and a broadcast link stay valid in any menu; any other stale button resolves to nothing.
 */
export function resolveAuthorCallback(
  state: AuthorState,
  callbackData: string,
): AuthorAction | undefined {
  const [, token, index = ""] = callbackData.split(":");
  if (token === "open-broadcast")
    return BROADCAST_ID.test(index)
      ? { kind: "read-broadcast", id: index }
      : undefined;
  if ((token === "broadcasts" || token === "home") && index === "0")
    return { kind: token };
  return token === state.token && /^\d+$/.test(index)
    ? state.actions[Number(index)]
    : undefined;
}

/** Menus with several choices to pick from are never paged. */
const CHOICE_KINDS = new Set<AuthorActionKind>([
  "compose:choose",
  "read-post",
  "read-broadcast",
  "show-part",
  "f:read",
  "f:part",
  "f:message",
]);
const PAGE_SIZE = 4;

/** The buttons of one page of a long menu; the last button stays on every page. */
export function pageAuthorMenu(menu: AuthorMenu, page: number): AuthorButton[] {
  if (
    menu.buttons.length <= 6 ||
    menu.buttons.filter(([, action]) => CHOICE_KINDS.has(action.kind)).length >
      1
  )
    return menu.buttons;
  const last = menu.buttons.at(-1);
  const options = menu.buttons.slice(0, -1);
  const buttons = options.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  if (page > 0)
    buttons.push([
      "← Предыдущие действия",
      { kind: "menu:page", value: String(page - 1) },
    ]);
  if (options.length > (page + 1) * PAGE_SIZE)
    buttons.push(["Ещё →", { kind: "menu:page", value: String(page + 1) }]);
  if (last) buttons.push(last);
  return buttons;
}

/**
 * Reads a stored session. Returns undefined when this version cannot trust its shape, and the
 * dialog then starts from its home menu; saved drafts live outside the session.
 */
export function parseAuthorState(stored: unknown): AuthorState | undefined {
  if (!isRecord(stored)) return undefined;
  const state = stored.version === undefined ? upgradeV0(stored) : stored;
  return isAuthorState(state) ? state : undefined;
}

function upgradeV0(stored: Record<string, unknown>): Record<string, unknown> {
  // Version 0 kept the awaited button title beside a string prompt.
  const { prompt, buttonTitle, ...rest } = stored;
  delete rest.buttonUrl;
  const upgraded: Record<string, unknown> = {
    ...rest,
    version: AUTHOR_STATE_VERSION,
  };
  if (prompt !== undefined)
    upgraded.prompt =
      prompt === "button-url"
        ? { kind: prompt, buttonTitle }
        : { kind: prompt };
  return upgraded;
}

function isAuthorState(value: unknown): value is AuthorState {
  return (
    isRecord(value) &&
    value.version === AUTHOR_STATE_VERSION &&
    typeof value.token === "string" &&
    Array.isArray(value.actions) &&
    value.actions.every(isAuthorAction) &&
    optional(value.freshMenu, (v) => typeof v === "boolean") &&
    optional(value.batch, (v) => v === "broadcast" || v === "funnel") &&
    optional(value.menu, isAuthorMenu) &&
    optional(value.composing, isComposerState) &&
    optional(value.broadcastName, isString) &&
    optional(value.pendingSchedule, (v) => v === null || isString(v)) &&
    optional(value.libraryQuery, isString) &&
    optional(value.funnelAuthor, isFunnelState) &&
    optional(value.template, isTemplate) &&
    optional(value.broadcast, isBroadcast) &&
    optional(value.prompt, isAuthorPrompt) &&
    optional(
      value.replacePart,
      (v) => isRecord(v) && isString(v.broadcastId) && isString(v.partId),
    )
  );
}

const ACTION_KINDS = new Set<unknown>(AUTHOR_ACTION_KINDS);

function isAuthorAction(value: unknown): value is AuthorAction {
  return (
    isRecord(value) &&
    ACTION_KINDS.has(value.kind) &&
    optional(value.id, isString) &&
    optional(value.value, isString)
  );
}

function isAuthorMenu(value: unknown): value is AuthorMenu {
  return (
    isRecord(value) &&
    isString(value.text) &&
    Array.isArray(value.buttons) &&
    value.buttons.every(
      (button) =>
        Array.isArray(button) &&
        button.length === 2 &&
        isString(button[0]) &&
        isAuthorAction(button[1]),
    )
  );
}

const PROMPT_KINDS = new Set<unknown>([
  "capture",
  "replace",
  "button-title",
  "schedule",
  "broadcast-name",
  "post-search",
]);

function isAuthorPrompt(value: unknown): value is AuthorPrompt {
  if (!isRecord(value)) return false;
  if (value.kind === "button-url") return isString(value.buttonTitle);
  return PROMPT_KINDS.has(value.kind);
}

const COMPOSER_PROMPTS = new Set<unknown>([
  "capture",
  "search",
  "button-title",
  "button-url",
  "button-row",
]);

function isComposerState(value: unknown): value is ComposerState {
  if (!isRecord(value) || !isRecord(value.destination)) return false;
  const destination = value.destination;
  return (
    (destination.kind === "broadcast" ||
      (destination.kind === "funnel" && isString(destination.target))) &&
    isString(destination.id) &&
    typeof destination.expectedRevision === "number" &&
    optional(value.prompt, (v) => COMPOSER_PROMPTS.has(v))
  );
}

const FUNNEL_PROMPTS = new Set<unknown>([
  "name",
  "delay",
  "source-name",
  "source-code",
  "part-delay",
]);

function isFunnelState(value: unknown): value is AuthorFunnelState {
  return (
    isRecord(value) &&
    optional(value.funnel, (v) => isRecord(v) && isString(v.funnelId)) &&
    optional(value.intro, (v) => isRecord(v) && isString(v.introId)) &&
    optional(value.prompt, (v) => FUNNEL_PROMPTS.has(v))
  );
}

function isTemplate(value: unknown): value is TemplateSnapshot {
  return (
    isRecord(value) &&
    isString(value.templateId) &&
    typeof value.revision === "number" &&
    isRecord(value.content)
  );
}

function isBroadcast(
  value: unknown,
): value is ReturnType<typeof broadcastView> {
  return (
    isRecord(value) &&
    isString(value.broadcastId) &&
    typeof value.revision === "number" &&
    isString(value.state) &&
    Array.isArray(value.parts)
  );
}

function optional(value: unknown, check: (value: unknown) => boolean) {
  return value === undefined || check(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
