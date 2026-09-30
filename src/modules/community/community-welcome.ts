/**
 * Stream facts that Platform owns and that the welcome may show. None reaches Telegram yet:
 * the stream start date waits for a Platform contract (platform#814), so every current
 * welcome goes without it.
 */
export interface CommunityWelcomeDetails {
  /** Calendar date of the stream start as `YYYY-MM-DD`. */
  readonly streamStartsOn?: string;
}

const STREAM_START = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/** The private welcome with the personal link; the link stays the last line. */
export function communityWelcomeMessage(
  text: string,
  inviteLink: string,
  details: CommunityWelcomeDetails = {},
): string {
  const start = details.streamStartsOn
    ? `\nСтарт потока: ${STREAM_START.format(new Date(`${details.streamStartsOn}T00:00:00Z`))}`
    : "";
  return `${text}${start}\n${inviteLink}`;
}
