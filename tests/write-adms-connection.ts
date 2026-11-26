/**
 * Write the application's encrypted ADMS connection profile (dev/test
 * helper — the production path is the setup wizard's ACTIVATE step,
 * which writes the same profile server-side).
 *
 * Usage:
 *   bun tests/write-adms-connection.ts <apiUrl> <token>
 *
 * Example:
 *   bun tests/write-adms-connection.ts http://127.0.0.1:18082 "$BICMS_ADMS_TOKEN"
 *
 * The token is stored AES-256-GCM encrypted (same derivation as
 * src/lib/biometric/terminal-security.ts) under `.local/adms/connections/`
 * (or TERMINAL_ADMS_CONNECTION_DIR) — the same store the ADMS settings
 * resolver reads. The plaintext token is never printed or persisted
 * unencrypted.
 */
import "dotenv/config";
import { createCipheriv, createHash } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const KEY_VERSION = "v1";

function loadKey(): Buffer {
  const envKey = process.env.DEVICE_MASTER_KEY;
  if (envKey && /^[0-9a-fA-F]{64}$/.test(envKey.trim())) {
    return Buffer.from(envKey.trim(), "hex");
  }
  // Deterministic fallback — identical to terminal-security.ts
  return createHash("sha256")
    .update(`${process.env.AUTH_SECRET || "aogc-border-import-control-secret-key-2024"}::device-comm-key::${KEY_VERSION}`)
    .digest();
}

function encryptSecret(plain: string): string {
  const iv = Buffer.from(randomBytesImpl(12));
  const cipher = createCipheriv("aes-256-gcm", loadKey(), iv);
  const plainBuf = Buffer.from(plain, "utf8");
  const ciphertext = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

// node:crypto randomBytes via the crypto module namespace
import { randomBytes as _randomBytes } from "crypto";
function randomBytesImpl(n: number): Uint8Array {
  return _randomBytes(n);
}

const [apiUrl, token] = process.argv.slice(2);
if (!apiUrl || !token) {
  console.error("usage: bun tests/write-adms-connection.ts <apiUrl> <token>");
  process.exit(1);
}

const dir =
  process.env.TERMINAL_ADMS_CONNECTION_DIR?.trim() ||
  join(process.cwd(), ".local", "adms", "connections");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = join(dir, `${Buffer.from(apiUrl).toString("base64url")}.json`);
writeFileSync(
  file,
  JSON.stringify(
    {
      apiUrl,
      caPem: "",
      tokenEnc: encryptSecret(token),
      createdAt: new Date().toISOString(),
    },
    null,
    2
  ),
  { mode: 0o600 }
);
console.log(`connection profile written for ${apiUrl} (token encrypted at rest)`);
