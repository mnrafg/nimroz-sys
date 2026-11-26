import "server-only";

// ============================================================
// Terminal biometric rules — pure, testable logic shared by the
// LAN manager, the ADMS feed and the enrollment workflows.
//
// These windows/mappings reproduce the reference branch's rules
// (spec: biometric-setup @2a9c2c2). They are implementation
// assumptions for the supported terminal formats (uFace800-class
// firmware), NOT a universal interpretation of every ZKTeco
// firmware — see the delivery report.
// ============================================================

export const TERMINAL_TRANSPORTS = ["LAN", "ADMS_SERVER"] as const;
export type TerminalTransport = (typeof TERMINAL_TRANSPORTS)[number];

export const TERMINAL_METHODS = ["FINGERPRINT", "FACE", "PALM"] as const;
export type TerminalMethod = (typeof TERMINAL_METHODS)[number];

export function isBiometricMethod(m: string): m is TerminalMethod {
  return (TERMINAL_METHODS as readonly string[]).includes(m);
}

/**
 * Verification-mode → method mapping (reference mapping, tested
 * against uFace800-class firmware):
 *   1        → fingerprint
 *   15–20    → face
 *   25–29    → palm
 *   2 / 4    → card          (NEVER establishes identity)
 *   0 / 3    → password      (NEVER establishes identity)
 *   other    → unknown/other (NEVER establishes identity)
 */
export function terminalMethodForMode(mode: number): TerminalMethod | "CARD" | "PASSWORD" | "UNKNOWN" {
  if (!Number.isInteger(mode) || mode < 0 || mode > 65535) return "UNKNOWN";
  if (mode === 1) return "FINGERPRINT";
  if (mode >= 15 && mode <= 20) return "FACE";
  if (mode >= 25 && mode <= 29) return "PALM";
  if (mode === 2 || mode === 4) return "CARD";
  if (mode === 0 || mode === 3) return "PASSWORD";
  return "UNKNOWN";
}

/**
 * Terminal user IDs are positive numeric strings, up to nine digits.
 * They identify an EXISTING user on the physical terminal — never a
 * generated website code.
 */
export const TERMINAL_USER_ID_RE = /^[1-9][0-9]{0,8}$/;

export function isValidTerminalUserId(v: unknown): v is string {
  return typeof v === "string" && TERMINAL_USER_ID_RE.test(v);
}

export function normalizeSerial(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toUpperCase();
  return s.length >= 4 && s.length <= 64 ? s : null;
}

// ---------- time / freshness rules ----------

/** Maximum accepted age of a scan event (device timestamp vs server clock). */
export const SCAN_MAX_AGE_SEC = 90;
/** Maximum tolerated future drift of a device timestamp. */
export const SCAN_MAX_FUTURE_SEC = 10;
/** Enrollment request lifetime. */
export const ENROLLMENT_TTL_SEC = 120;
/** Live-scan lease lifetime. */
export const LEASE_TTL_SEC = 25;
/** Lease renewal / authorization refresh interval. */
export const LEASE_RENEWAL_MS = 8_000;
/** SSE scan-polling interval while a lease is active. */
export const SCAN_POLL_MS = 400;
/** ADMS feed polling interval while the device is in use. */
export const ADMS_POLL_MS = 1_000;
/** Stop ADMS monitoring after this much inactivity. */
export const ADMS_IDLE_STOP_MS = 60_000;
/** LAN keep-alive / serial re-verification heartbeat. */
export const LAN_HEARTBEAT_MS = 20_000;
/** Bounded connection and reply timeouts. */
export const LAN_CONNECT_TIMEOUT_MS = 6_000;
export const LAN_REPLY_TIMEOUT_MS = 8_000;

/** Kabul business offset: UTC+04:30 → 270 minutes. */
export const DEFAULT_TZ_OFFSET_MINUTES = 270;

/**
 * Interpret a device-LOCAL timestamp with the configured offset and
 * return the true UTC instant. `deviceLocalMs` is epoch ms computed as
 * if the local wall-clock were UTC.
 */
export function deviceLocalToUtc(deviceLocalMs: number, offsetMinutes: number): Date {
  return new Date(deviceLocalMs - offsetMinutes * 60_000);
}

/** Inverse of deviceLocalToUtc — for displaying device time. */
export function utcToDeviceLocal(utc: Date, offsetMinutes: number): Date {
  return new Date(utc.getTime() + offsetMinutes * 60_000);
}

/**
 * Freshness check for a scan whose device-local time was interpreted
 * with `offsetMinutes`. Fresh = not older than 90 s and not more than
 * 10 s in the future, relative to the SERVER clock.
 */
export function isFreshDeviceTime(utc: Date, now = new Date()): boolean {
  const t = utc.getTime();
  const n = now.getTime();
  return t <= n + SCAN_MAX_FUTURE_SEC * 1000 && t >= n - SCAN_MAX_AGE_SEC * 1000;
}

/** Parse "YYYY-MM-DD HH:mm:ss" (device-local wall clock). */
export function parseDeviceLocalTimestamp(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m.map(Number) as unknown as number[];
  const ms = Date.UTC(y, mo - 1, d, h, mi, se);
  return Number.isFinite(ms) ? ms : null;
}

// ---------- stage failure messages (Dari, shown to staff) ----------

export const STAGE_MESSAGES = {
  NETWORK_UNREACHABLE:
    "اتصال به دستگاه در شبکه محلی ناموفق بود؛ آدرس و پورت را بررسی کنید.",
  PROTOCOL_FAILED:
    "دستگاه به درخواست پروتکل پاسخ نداد؛ اتصال TCP تنها به معنی آمادگی دستگاه نیست.",
  AUTH_FAILED:
    "احراز هویت پروتکل ناموفق بود؛ کلید ارتباط دستگاه صحیح نیست.",
  SERIAL_MISMATCH:
    "شماره سریال دستگاه با ثبت داخل سیستم مطابقت ندارد؛ رویدادها پذیرفته نمی‌شوند.",
  SUBSCRIPTION_FAILED:
    "فعال‌سازی رویدادهای زنده روی دستگاه ناموفق بود.",
  DISCONNECTED: "ارتباط با دستگاه قطع شد؛ سیستم به‌صورت خودکار دوباره تلاش می‌کند.",
} as const;

export type TerminalStage =
  | "DISCONNECTED"
  | "CONNECTING"
  | "CONNECTED"
  | "AUTHENTICATED"
  | "SERIAL_VERIFIED"
  | "SUBSCRIBED"
  | "FAILED";

export interface TerminalStageInfo {
  stage: TerminalStage;
  completedStage?: TerminalStage | null;
  stageError: string | null;
  detail: string | null;
}

// ---------- biometric eligibility (shared by LAN + ADMS paths) ----------

export interface EligibleScanInput {
  verifyMode: number;
  deviceTimeUtc: Date;
}

/**
 * A scan may enter the pipeline ONLY when the verify mode maps to a
 * supported biometric method. Cards, passwords, failed verification,
 * finger-presence notifications, alarms and unknown modes never do.
 */
export function classifyScanEligibility(
  input: EligibleScanInput,
  now = new Date()
): { ok: true; method: TerminalMethod } | { ok: false; reason: "NON_BIOMETRIC" | "STALE" } {
  const mode = terminalMethodForMode(input.verifyMode);
  if (!isBiometricMethod(mode)) return { ok: false, reason: "NON_BIOMETRIC" };
  if (!isFreshDeviceTime(input.deviceTimeUtc, now)) return { ok: false, reason: "STALE" };
  return { ok: true, method: mode };
}

/** Deterministic dedup key for a raw scan (replay-safe). */
export function scanEventKey(serial: string, userId: string, punch: number, verify: number, deviceLocalMs: number): string {
  return `${serial}:${userId}:${punch}:${verify}:${deviceLocalMs}`;
}
