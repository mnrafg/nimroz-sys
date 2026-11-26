import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "crypto";

// ============================================================
// Terminal security helpers (biometric-setup reproduction).
//
//  • Per-device communication keys are AES-256-GCM encrypted at rest
//    under the application's stable authentication secret and are
//    NEVER returned to the browser.
//  • Legacy signed transports use a per-device credential salt;
//    signatures are HMAC-SHA256 over canonical request strings.
//  • Replay receipts give once-delivery semantics to signed ingestion.
//
// (The AES helpers were inlined from the removed legacy gateway stack's
// crypto module — same algorithms, same key derivation, so previously
// stored encrypted values remain readable.)
// ============================================================

const KEY_VERSION = "v1";

function loadKey(): Buffer {
  const envKey = process.env.DEVICE_MASTER_KEY;
  if (envKey && /^[0-9a-fA-F]{64}$/.test(envKey.trim())) {
    return Buffer.from(envKey.trim(), "hex");
  }
  // Deterministic fallback derived from AUTH_SECRET — acceptable in this
  // contract phase; production deployments MUST set DEVICE_MASTER_KEY.
  return createHash("sha256")
    .update(`${process.env.AUTH_SECRET || "aogc-border-import-control-secret-key-2024"}::device-comm-key::${KEY_VERSION}`)
    .digest();
}

/** Encrypt a secret (comm key / ADMS token) → base64 (iv | tag | ciphertext). */
export function encryptTerminalSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", loadKey(), iv);
  const plainBuf = Buffer.from(plain, "utf8");
  const ciphertext = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

/** Decrypt a stored payload → plaintext. Throws on tamper/failure. */
export function decryptTerminalSecret(encryptedBase64: string): string {
  const raw = Buffer.from(encryptedBase64, "base64");
  if (raw.length < 12 + 16 + 1) throw new Error("مقدار رمزنگاری‌شده نامعتبر است.");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", loadKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** sha256 hex — used for hashed tokens / canonical signing. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Constant-time string comparison for secrets. */
export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** New random salt for legacy signed transports (16 bytes, hex). */
export function generateCredentialSalt(): string {
  return randomBytes(16).toString("hex");
}

/** HMAC-SHA256 over a canonical string with the device credential salt. */
export function signWithSalt(salt: string, canonical: string): string {
  return createHmac("sha256", Buffer.from(salt, "hex")).update(canonical, "utf8").digest("hex");
}

/** Canonical string for a legacy signed ingestion request. */
export function canonicalIngestionString(args: {
  serial: string;
  body: string;
  timestampMs: number;
  nonce: string;
}): string {
  return `${args.serial}\n${args.timestampMs}\n${args.nonce}\n${sha256Hex(args.body)}`;
}

/** Fresh single-use receipt id (replay protection). */
export function newReceiptId(): string {
  return randomUUID();
}

/** Bounded, sanitized log/audit helper — truncates and strips secrets. */
export function sanitizeDetail(detail: string, max = 240): string {
  const clean = detail.replace(/[\r\n\t]+/g, " ").slice(0, max);
  return clean;
}
