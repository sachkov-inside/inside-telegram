const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

export function localProofDatabaseUrl(value: string, name: string): string {
  const url = parseUrl(value, name);
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.search !== "" ||
    url.hash !== "" ||
    !/(proof|conformance)/u.test(databaseName.toLowerCase())
  ) {
    throw new Error(
      `${name} must be a direct loopback PostgreSQL proof database URL without routing parameters`,
    );
  }
  return value;
}

export function loopbackHttpUrl(value: string, name: string): string {
  const url = parseUrl(value, name);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`${name} must target a direct loopback HTTP endpoint`);
  }
  return value;
}

function parseUrl(value: string, name: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
}
