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
