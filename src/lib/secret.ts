import "server-only";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

/**
 * Central secret resolution (V1 fix).
 *
 * Security rule: the JWT/HMAC signing secret must NEVER fall back to a
 * value that is publicly committed in the repository. When AUTH_SECRET
 * is not provided via the environment, a strong random secret is
 * generated ONCE and persisted inside the private db/ folder (never
 * committed, readable only by the server process). Sessions therefore
 * survive restarts, but an attacker who only has the source code cannot
 * mint valid session tokens.
 */
let cachedSecret: string | null = null;

const SECRET_FILE = join(process.cwd(), "db", ".auth-secret");
const SECRET_FILE_V2 = join(process.cwd(), "db", ".hmac-secret-v2");

function randomSecret(): string {
  return randomBytes(48).toString("base64url");
}

function loadOrCreatePersistedSecret(): string {
  for (const path of [SECRET_FILE_V2, SECRET_FILE]) {
    try {
      if (existsSync(path)) {
        const value = readFileSync(path, "utf8").trim();
        if (value.length >= 32) return value;
      }
    } catch {
      // fall through to creation
    }
  }
  const generated = randomSecret();
  try {
    writeFileSync(SECRET_FILE_V2, generated, { mode: 0o600 });
    return generated;
  } catch {
    // Extremely restricted filesystems: last resort is a per-process
    // random secret (sessions reset on restart, but never guessable).
    return generated;
  }
}

export function getAuthSecret(): string {
  if (cachedSecret) return cachedSecret;
  const fromEnv = process.env.AUTH_SECRET?.trim();
  cachedSecret =
    fromEnv && fromEnv.length >= 24 ? fromEnv : loadOrCreatePersistedSecret();
  return cachedSecret;
}
