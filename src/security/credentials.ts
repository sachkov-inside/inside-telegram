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
