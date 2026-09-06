import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import schema from "./contracts/inside-communications-v1/schema.json" with { type: "json" };

export const COMMUNICATIONS_VERSION = "inside-communications-v1" as const;
export interface Actor {
  readonly accountRef: string;
}
export interface FormattingEntity {
  readonly type: string;
  readonly offset: number;
  readonly length: number;
  readonly url?: string;
  readonly language?: string;
}
export interface TemplateContent {
  readonly type:
    "text" | "photo" | "video" | "video_note" | "voice" | "document";
  readonly text: string;
  readonly entities: readonly FormattingEntity[];
  readonly buttons: readonly { readonly text: string; readonly url: string }[];
  readonly fileId?: string;
}
export interface TemplateSnapshot {
  readonly templateId: string;
  readonly revision: number;
  readonly botIdentity: string;
  readonly content: TemplateContent;
}
export interface CommunicationsRequest {
  readonly contractVersion: typeof COMMUNICATIONS_VERSION;
  readonly operation: string;
  readonly operationId: string;
  readonly expectedRevision: number;
  readonly actor: Actor | { readonly serviceRef: "platform-tracking" };
  readonly payload: {
    readonly templateId?: string;
    readonly content?: TemplateContent;
  };
}
export type CommunicationsErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "malformed"
  | "unsupported_content"
  | "revision_conflict"
  | "operation_conflict"
  | "authorization_unavailable"
  | "not_implemented";
export class CommunicationsError extends Error {
  constructor(readonly code: CommunicationsErrorCode) {
    super(code);
  }
}
const ajv = new Ajv({ strict: true });
addFormats.default(ajv);
ajv.addSchema(schema);
export function contractValidator(definition: string) {
  return ajv.compile({ $ref: `${schema.$id}#/definitions/${definition}` });
}
export const validRequest = contractValidator("request");
const validContent = contractValidator("content");

export function validateContent(
  value: unknown,
): asserts value is TemplateContent {
  if (!validContent(value))
    throw new CommunicationsError("unsupported_content");
  const content = value as TemplateContent;
  if (
    content.type === "text"
      ? !content.text || content.fileId !== undefined
      : !content.fileId
  )
    throw new CommunicationsError("unsupported_content");
  if (
    (content.type === "text" && content.text.length > 4096) ||
    (content.type !== "text" && content.text.length > 1024) ||
    (content.type === "video_note" &&
      (content.text !== "" || content.entities.length > 0))
  )
    throw new CommunicationsError("unsupported_content");
  for (const button of content.buttons) assertSafeUrl(button.url);
  for (const entity of content.entities) {
    const end = entity.offset + entity.length;
    if (
      end > content.text.length ||
      splitsSurrogate(content.text, entity.offset) ||
      splitsSurrogate(content.text, end)
    )
      throw new CommunicationsError("unsupported_content");
    if (
      (entity.type === "text_link") !== (entity.url !== undefined) ||
      (entity.language !== undefined && entity.type !== "pre")
    )
      throw new CommunicationsError("unsupported_content");
    if (entity.url) assertSafeUrl(entity.url);
    if (entity.type === "url")
      assertSafeUrl(content.text.slice(entity.offset, end), true);
    for (const other of content.entities) {
      if (other === entity) continue;
      const otherEnd = other.offset + other.length;
      if (entity.offset < otherEnd && other.offset < end) {
        const contained =
          (entity.offset <= other.offset && end >= otherEnd) ||
          (other.offset <= entity.offset && otherEnd >= end);
        const styles = [
          "bold",
          "italic",
          "underline",
          "strikethrough",
          "spoiler",
        ];
        if (
          !contained ||
          [entity.type, other.type].some(
            (type) => type === "pre" || type === "code",
          ) ||
          (!styles.includes(entity.type) && !styles.includes(other.type))
        )
          throw new CommunicationsError("unsupported_content");
      }
    }
  }
  // Never let Telegram's credential-bearing download addresses escape through text or links.
  for (const match of content.text.matchAll(/\bhttps?:\/\/[^\s<>"']+/gi)) {
    let url: URL;
    try {
      url = new URL(match[0]);
    } catch {
      continue;
    }
    if (isTelegramEndpoint(url))
      throw new CommunicationsError("unsupported_content");
  }
  if (/api\.telegram\.org\.?(?::[0-9]+)?\/file\/bot/i.test(content.text))
    throw new CommunicationsError("unsupported_content");
}
function splitsSurrogate(text: string, index: number): boolean {
  return (
    index > 0 &&
    index < text.length &&
    /[\uD800-\uDBFF]/.test(text[index - 1]!) &&
    /[\uDC00-\uDFFF]/.test(text[index]!)
  );
}
function assertSafeUrl(value: string, allowBareDomain = false): void {
  let url: URL;
  try {
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(value);
    url = new URL(allowBareDomain && !hasScheme ? `https://${value}` : value);
  } catch {
    throw new CommunicationsError("unsupported_content");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    isTelegramEndpoint(url)
  )
    throw new CommunicationsError("unsupported_content");
}

function isTelegramEndpoint(url: URL): boolean {
  return url.hostname.replace(/\.$/, "") === "api.telegram.org";
}
