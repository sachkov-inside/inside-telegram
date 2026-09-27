import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

/**
 * Loads `ENV_FILE` (default `.env`) into process.env when that file exists; production reads
 * its environment from Compose and has no such file. Inherited values win unless
 * `ENV_FILE_OVERRIDE=true`, which the credentialed proof sets so that only its isolated file
 * decides the settings.
 */
export function loadEnvironmentFile(): void {
  const path = process.env.ENV_FILE ?? ".env";
  if (!existsSync(path)) return;
  if (process.env.ENV_FILE_OVERRIDE === "true")
    Object.assign(process.env, parseEnv(readFileSync(path, "utf8")));
  else process.loadEnvFile(path);
}
