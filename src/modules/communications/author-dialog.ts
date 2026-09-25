import type { broadcastView } from "./broadcasts.js";
import {
  contractValidator,
  type TemplateContent,
  type TemplateSnapshot,
} from "./communications-contract.js";
import type { FunnelSnapshot, IntroSnapshot } from "./funnel-types.js";

type Field = "required" | "optional";
interface PayloadSpec {
  readonly id?: Field;
  readonly value?: Field | readonly string[];
}

/**
 * Every button of the author admin dialog with the data it carries: `id` names a selected
 * object or a page cursor, `value` a position, an offset or a choice. A menu stores the actions
 * it showed, so a persisted session may only contain actions that match this table.
 */
const AUTHOR_ACTIONS = {
  "batch:broadcast": {},
  "batch:done": {},
  "batch:funnel": {},
  "broadcast-sample": {},
  broadcasts: { id: "optional" },
  button: {},
  cancel: {},
  "confirm-cancel": {},
  "confirm-launch": {},
  "create-broadcast": {},
  home: {},
  launch: {},
  "menu:page": { value: "required" },
  "move-part": { value: "required" },
  "new-broadcast": {},
  overview: {},
  parts: { value: "optional" },
  pause: {},
  "pick-part": {},
  "post-search": {},
  posts: { id: "optional" },
  "posts-all": {},
  "read-broadcast": { id: "required" },
  "read-post": { id: "required" },
  "remove-button": { value: "required" },
  "remove-part": { value: "required" },
  replace: {},
  "replace-part": { value: "required" },
  resume: {},
  sample: {},
  "show-part": { id: "required" },
  statistics: {},
  "compose:accept": {},
  "compose:all": {},
  "compose:broadcast": {},
  "compose:button": {},
  "compose:cancel": {},
  "compose:choose": { id: "required" },
  "compose:discard": { id: "required" },
  "compose:edit-broadcast": { id: "required" },
  "compose:edit-funnel": { id: "required" },
  "compose:funnel": {},
  "compose:library": { id: "optional" },
  "compose:preview": {},
  "compose:remove-button": { value: "required" },
  "compose:replace": {},
  "compose:resume": { id: "required" },
  "compose:search": {},
  "sequence:broadcast": {},
  "sequence:discard": {},
  "sequence:done": {},
  "sequence:funnel": {},
  "sequence:time": { value: "required" },
  "f:add-source": {},
  "f:add-step": {},
  "f:confirm-archive": {},
  "f:default": {},
  "f:delay": {},
  "f:discard": {},
  "f:intro": {},
  "f:life": { value: ["pause", "resume", "archive", "restore"] },
  "f:list": { id: "optional" },
  "f:message": { id: "required", value: "required" },
  "f:messages": { value: "optional" },
  "f:move-part": { id: "required", value: "required" },
  "f:move-step": { id: "required", value: "required" },
  "f:name": {},
  "f:new": {},
  "f:part": { id: "required" },
  "f:parts": { id: "required" },
  "f:parts-page": { value: "required" },
  "f:posts": { value: "optional" },
  "f:preview": {},
  "f:publish": {},
  "f:read": { id: "required" },
  "f:remove-part": { id: "required" },
  "f:remove-source": { id: "required" },
  "f:remove-step": { id: "required" },
  "f:sample": {},
  "f:save": {},
  "f:save-intro": {},
  "f:settings": {},
  "f:show": {},
  "f:source": { id: "required" },
  "f:sources": { value: "optional" },
  "f:step": { id: "required" },
  "f:steps": { value: "optional" },
  "f:timing": { id: "required" },
  "f:timing-entry": { id: "required" },
} as const satisfies Record<string, PayloadSpec>;

type ActionSpecs = typeof AUTHOR_ACTIONS;
export type AuthorActionKind = keyof ActionSpecs;

type IdPayload<Spec> = Spec extends { id: "required" }
  ? { readonly id: string }
  : Spec extends { id: "optional" }
    ? { readonly id?: string }
    : unknown;
type ValuePayload<Spec> = Spec extends { value: "required" }
  ? { readonly value: string }
  : Spec extends { value: "optional" }
    ? { readonly value?: string }
    : Spec extends { value: readonly (infer Choice)[] }
      ? { readonly value: Choice }
      : unknown;

/** One button's action: its kind names the handler and fixes which payload it carries. */
export type AuthorAction = {
  [Kind in AuthorActionKind]: { readonly kind: Kind } & IdPayload<
    ActionSpecs[Kind]
  > &
    ValuePayload<ActionSpecs[Kind]>;
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

const AUTHOR_PROMPT_KINDS = ["replace", "button-title", "post-search"] as const;

/** The text the dialog waits for from the author outside a composer or funnel prompt. */
export type AuthorPrompt =
  | { readonly kind: (typeof AUTHOR_PROMPT_KINDS)[number] }
  | { readonly kind: "button-url"; readonly buttonTitle: string };

/** Where an accepted message goes: a broadcast or one block of a funnel. */
export type MessageDestination = { expectedRevision: number } & (
  | { kind: "broadcast"; id: string; partId?: string }
  | { kind: "funnel"; id: string; target: string; partId?: string }
);

const COMPOSER_PROMPTS = [
  "capture",
  "search",
  "button-title",
  "button-url",
  "button-row",
] as const;

/** A message being prepared; it changes its destination only after explicit acceptance. */
export interface ComposerState {
  destination: MessageDestination;
  sequence?: { lastOffset: number; firstEntry: boolean };
  content?: TemplateContent;
  prompt?: (typeof COMPOSER_PROMPTS)[number];
  buttonTitle?: string;
  buttonUrl?: string;
  query?: string;
  libraryCursor?: string;
}

const FUNNEL_PROMPTS = [
  "name",
  "delay",
  "source-name",
  "source-code",
  "part-delay",
] as const;

/** The funnel or shared intro being edited, with its unsaved changes. */
export interface AuthorFunnelState {
  funnel?: FunnelSnapshot;
  intro?: IntroSnapshot;
  dirty?: boolean;
  /** `entry`, `intro` or the ID of the selected funnel step. */
  target?: string;
  replacePartId?: string;
  prompt?: (typeof FUNNEL_PROMPTS)[number];
  sourceName?: string;
  timingPartId?: string;
}

export type AuthorBroadcast = ReturnType<typeof broadcastView>;

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
  libraryQuery?: string;
  funnelAuthor?: AuthorFunnelState;
  template?: TemplateSnapshot;
  broadcast?: AuthorBroadcast;
  prompt?: AuthorPrompt;
  replacePart?: { broadcastId: string; partId: string };
}

export function emptyAuthorState(token: string): AuthorState {
  return { version: AUTHOR_STATE_VERSION, token, actions: [] };
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
  "f:step",
  "f:source",
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

/** Reads a stored funnel or intro draft; undefined when its shape is not trusted. */
export function parseFunnelDraft(
  stored: unknown,
): AuthorFunnelState | undefined {
  return isFunnelState(stored) ? stored : undefined;
}

/** Reads a stored unsaved broadcast; undefined when its shape is not trusted. */
export function parseBroadcastDraft(
  stored: unknown,
): AuthorBroadcast | undefined {
  return isBroadcast(stored) ? stored : undefined;
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

// Leaf values come from validated input or Platform, so the contract schema describes them.
// Containers are checked by shape: an unsaved draft may still lack required parts.
const validContent = contractValidator("content");
const validPart = contractValidator("part");
const validBroadcastPart = contractValidator("broadcastPart");
const validSource = contractValidator("source");
const validAudience = contractValidator("audience");
const validTemplate = contractValidator("template");

function isAuthorState(value: unknown): value is AuthorState {
  return (
    isRecord(value) &&
    value.version === AUTHOR_STATE_VERSION &&
    isString(value.token) &&
    Array.isArray(value.actions) &&
    value.actions.every(isAuthorAction) &&
    optional(value.freshMenu, isBoolean) &&
    optional(value.batch, (v) => v === "broadcast" || v === "funnel") &&
    optional(value.menu, isAuthorMenu) &&
    optional(value.composing, isComposerState) &&
    optional(value.broadcastName, isString) &&
    optional(value.libraryQuery, isString) &&
    optional(value.funnelAuthor, isFunnelState) &&
    optional(value.template, (v) => validTemplate(v)) &&
    optional(value.broadcast, isBroadcast) &&
    optional(value.prompt, isAuthorPrompt) &&
    optional(
      value.replacePart,
      (v) => isRecord(v) && isString(v.broadcastId) && isString(v.partId),
    )
  );
}

function isAuthorAction(value: unknown): value is AuthorAction {
  if (
    !isRecord(value) ||
    !isString(value.kind) ||
    !Object.hasOwn(AUTHOR_ACTIONS, value.kind)
  )
    return false;
  const spec: PayloadSpec = AUTHOR_ACTIONS[value.kind as AuthorActionKind];
  return (
    matchesField(value.id, spec.id) &&
    (isChoice(spec.value)
      ? includes(spec.value, value.value)
      : matchesField(value.value, spec.value))
  );
}

function isChoice(field: PayloadSpec["value"]): field is readonly string[] {
  return Array.isArray(field);
}

function matchesField(value: unknown, field: Field | undefined): boolean {
  return field === "required" ? isString(value) : optional(value, isString);
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

function isAuthorPrompt(value: unknown): value is AuthorPrompt {
  if (!isRecord(value)) return false;
  if (value.kind === "button-url") return isString(value.buttonTitle);
  return includes(AUTHOR_PROMPT_KINDS, value.kind);
}

function isComposerState(value: unknown): value is ComposerState {
  return (
    isRecord(value) &&
    isDestination(value.destination) &&
    optional(
      value.sequence,
      (v) => isRecord(v) && isNumber(v.lastOffset) && isBoolean(v.firstEntry),
    ) &&
    optional(value.content, (v) => validContent(v)) &&
    optional(value.prompt, (v) => includes(COMPOSER_PROMPTS, v)) &&
    optional(value.buttonTitle, isString) &&
    optional(value.buttonUrl, isString) &&
    optional(value.query, isString) &&
    optional(value.libraryCursor, isString)
  );
}

function isDestination(value: unknown): value is MessageDestination {
  return (
    isRecord(value) &&
    (value.kind === "broadcast" ||
      (value.kind === "funnel" && isString(value.target))) &&
    isString(value.id) &&
    isNumber(value.expectedRevision) &&
    optional(value.partId, isString)
  );
}

function isFunnelState(value: unknown): value is AuthorFunnelState {
  return (
    isRecord(value) &&
    optional(value.funnel, isFunnel) &&
    optional(value.intro, isIntro) &&
    optional(value.dirty, isBoolean) &&
    optional(value.target, isString) &&
    optional(value.replacePartId, isString) &&
    optional(value.prompt, (v) => includes(FUNNEL_PROMPTS, v)) &&
    optional(value.sourceName, isString) &&
    optional(value.timingPartId, isString)
  );
}

function isFunnel(value: unknown): value is FunnelSnapshot {
  return (
    isRecord(value) &&
    isString(value.funnelId) &&
    isString(value.name) &&
    isBoolean(value.isDefault) &&
    Array.isArray(value.sources) &&
    value.sources.every((source) => validSource(source)) &&
    isRecord(value.entryResponse) &&
    isString(value.entryResponse.stepId) &&
    isParts(value.entryResponse.parts) &&
    Array.isArray(value.steps) &&
    value.steps.every(
      (step) =>
        isRecord(step) &&
        isString(step.stepId) &&
        isNumber(step.delaySeconds) &&
        optional(step.delayAnchor, (v) => v === "entry") &&
        isParts(step.parts),
    ) &&
    isNumber(value.revision) &&
    (value.publishedRevision === null || isNumber(value.publishedRevision)) &&
    includes(["draft", "published", "paused", "archived"], value.lifecycle)
  );
}

function isIntro(value: unknown): value is IntroSnapshot {
  return (
    isRecord(value) &&
    isString(value.introId) &&
    isNumber(value.revision) &&
    isParts(value.parts)
  );
}

function isParts(value: unknown): boolean {
  return Array.isArray(value) && value.every((part) => validPart(part));
}

function isBroadcast(value: unknown): value is AuthorBroadcast {
  return (
    isRecord(value) &&
    isString(value.broadcastId) &&
    isNumber(value.revision) &&
    includes(
      ["draft", "scheduled", "running", "paused", "cancelled", "completed"],
      value.state,
    ) &&
    Array.isArray(value.parts) &&
    value.parts.every((part) => validBroadcastPart(part)) &&
    validAudience(value.audience) &&
    (value.scheduledAt === null || isString(value.scheduledAt)) &&
    (value.audienceSnapshotId === null || isString(value.audienceSnapshotId)) &&
    isNumber(value.snapshotSize)
  );
}

function includes(list: readonly string[], value: unknown): boolean {
  return (list as readonly unknown[]).includes(value);
}

function optional(value: unknown, check: (value: unknown) => boolean) {
  return value === undefined || check(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
