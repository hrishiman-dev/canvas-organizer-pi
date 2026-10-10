import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadProjectEnv(path = resolve(process.cwd(), ".env")): void {
  if (!existsSync(path)) return;
  for (const sourceLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (/^[A-Z_][A-Z0-9_]*$/.test(key) && process.env[key] === undefined) process.env[key] = value;
  }
}
