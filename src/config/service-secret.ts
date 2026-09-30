/**
 * Every service secret: 32-256 base64url characters. The same alphabet is Telegram's
 * webhook secret-token alphabet.
 */
export function assertServiceSecret(value: string, name: string): void {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(value))
    throw new Error(
      `${name} must be a base64url credential of 32 to 256 characters`,
    );
}

/** A service credential travels only over TLS, except to a loopback peer. */
export function assertServiceEndpoint(value: string, name: string): void {
  assertHttpUrl(value, name);
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw new Error(
      `${name} requires HTTPS (HTTP only on loopback), without credentials, query or fragment`,
    );
}

function assertHttpUrl(value: string, name: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an HTTP URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must be an HTTP URL`);
  }
}
