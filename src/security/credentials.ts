import { timingSafeEqual } from "node:crypto";

export function credentialsMatch(
  candidate: string | undefined,
  expected: string,
): boolean {
  if (!candidate) {
    return false;
  }
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return (
    candidateBytes.length === expectedBytes.length &&
    timingSafeEqual(candidateBytes, expectedBytes)
  );
}

/**
 * One place for the `Authorization: Bearer` shape shared by every
 * service-authenticated endpoint. An absent expected secret never matches.
 */
export function bearerMatches(
  authorization: string | undefined,
  expected: string | undefined,
): boolean {
  const prefix = "Bearer ";
  if (!expected || !authorization?.startsWith(prefix)) {
    return false;
  }
  return credentialsMatch(authorization.slice(prefix.length), expected);
}
