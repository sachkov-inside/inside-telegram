/** Stream facts that Platform owns and that the welcome may show. */
export interface CommunityWelcomeDetails {
  /** Calendar date of the stream start as `YYYY-MM-DD`. */
  readonly streamStartsOn?: string;
}

/**
 * Reads the course's current stream at the moment the welcome goes. An absent stream, an absent
 * date or an unavailable Platform all mean a welcome without details.
 */
export interface CommunityWelcomeDetailsSource {
  read(): Promise<CommunityWelcomeDetails>;
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
