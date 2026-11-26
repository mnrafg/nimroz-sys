import "server-only";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import {
  classifyScanEligibility,
  scanEventKey,
  deviceLocalToUtc,
  isValidTerminalUserId,
  type TerminalMethod,
} from "./terminal-rules";

// ============================================================
// Terminal scan ingestion — the single entry point for verified
// biometric events from BOTH transports (LAN manager + ADMS feed).
//
// Rules enforced here:
//  • only FINGERPRINT / FACE / PALM modes are ever stored
//  • replay-safe deduplication via deterministic eventKey
//  • device-local timestamps interpreted with the configured offset
//  • identity resolution stays a read (delivery-time concern)
//  • single-use consumption happens ONLY through consumeScan()
// ============================================================

export interface RawScanInput {
  serial: string;
  terminalUserId: string;
  punch: number;
  verify: number;
  deviceLocalMs: number;
  timezoneOffsetMinutes: number;
  /** Internal LAN event channel only; never accepted from HTTP ingestion. */
  source?: "LAN_LIVE";
}

export type IngestResult =
  | { ok: true; scanId: string; cursor: number; method: TerminalMethod; duplicate: boolean }
  | { ok: false; reason: "NON_BIOMETRIC" | "STALE" | "INVALID_USER" | "DEVICE_DISABLED" | "ERROR"; message: string };

/** Ingest one raw scan. Duplicates return ok with duplicate=true. */
export async function ingestTerminalScan(input: RawScanInput): Promise<IngestResult> {
  const receivedAt = new Date();
  if (!isValidTerminalUserId(input.terminalUserId)) {
    return { ok: false, reason: "INVALID_USER", message: "شناسه کاربر دستگاه نامعتبر است." };
  }
  // a DISABLED device stops participating in the app entirely — its
  // transport session may still drain frames for a moment, but nothing
  // is stored (spec: disabling stops app usage, never locks the terminal)
  const device = await db.terminalDevice.findUnique({
    where: { serial: input.serial },
    select: { isEnabled: true },
  });
  if (!device || !device.isEnabled) {
    return { ok: false, reason: "DEVICE_DISABLED", message: "این دستگاه در سیستم غیرفعال است." };
  }
  const deviceTimeUtc = deviceLocalToUtc(input.deviceLocalMs, input.timezoneOffsetMinutes);
  // Native events arrive on an authenticated, serial-verified live socket.
  // Their freshness comes from receipt, independently of the terminal clock.
  // ADMS/history and signed HTTP ingestion retain their device-time gate.
  const eligibility = classifyScanEligibility({
    verifyMode: input.verify,
    deviceTimeUtc: input.source === "LAN_LIVE" ? receivedAt : deviceTimeUtc,
  });
  if (!eligibility.ok) {
    return {
      ok: false,
      reason: eligibility.reason,
      message:
        eligibility.reason === "NON_BIOMETRIC"
          ? "رویداد غیر بایومتریک پذیرفته نمی‌شود."
          : "رویداد کهنه/آینده است و پذیرفته نمی‌شود.",
    };
  }
  const eventKey = scanEventKey(input.serial, input.terminalUserId, input.punch, input.verify, input.deviceLocalMs);
  try {
    const scan = await db.terminalScan.create({
      data: {
        eventKey,
        deviceKey: input.serial,
        terminalUserId: input.terminalUserId,
        verifyMode: input.verify,
        method: eligibility.method,
        deviceTime: deviceTimeUtc,
        receivedAt,
      },
      select: { id: true, scanId: true },
    });
    return { ok: true, scanId: scan.scanId, cursor: scan.id, method: eligibility.method, duplicate: false };
  } catch (e) {
    // Unique violation → this exact event was already ingested (replay)
    const msg = e instanceof Error ? e.message : "";
    if (msg.includes("Unique constraint")) {
      const existing = await db.terminalScan.findUnique({
        where: { eventKey },
        select: { id: true, scanId: true, method: true },
      });
      if (existing) {
        return { ok: true, scanId: existing.scanId, cursor: existing.id, method: existing.method as TerminalMethod, duplicate: true };
      }
    }
    return { ok: false, reason: "ERROR", message: "ثبت رویداد دستگاه ناموفق بود." };
  }
}

export interface ResolvedIdentity {
  importerId: number;
  method: string | null;
}

/** Resolve DEVICE SERIAL + TERMINAL USER ID → active importer (or null). */
export async function resolveTerminalIdentity(deviceKey: string, terminalUserId: string): Promise<ResolvedIdentity | null> {
  const identity = await db.terminalIdentity.findUnique({
    where: { deviceKey_terminalUserId: { deviceKey, terminalUserId } },
    select: { importerId: true, method: true, revokedAt: true, importer: { select: { status: true, membershipStatus: true } } },
  });
  if (!identity || identity.revokedAt) return null;
  if (identity.importer.status !== "ACTIVE" || identity.importer.membershipStatus !== "ACTIVE") return null;
  return { importerId: identity.importerId, method: identity.method };
}

/** Client for transaction-scoped consumption (Prisma tx or default db). */
type ScanClient = Prisma.TransactionClient | typeof db;

export type ConsumeResult =
  | { ok: true; scan: { scanId: string; terminalUserId: string; method: string; deviceTime: Date; importerId: number | null } }
  | { ok: false; reason: "NOT_FOUND" | "ALREADY_USED" | "STALE" | "ERROR"; message: string };

/**
 * Consume an unused scan EXACTLY ONCE (atomic conditional update).
 * `expected` lets callers pin device/user/enrollment constraints.
 * Passing a transaction `client` lets the caller roll consumption back
 * together with the surrounding transaction (enrollment completion).
 */
export async function consumeTerminalScan(
  scanId: string,
  expected?: { deviceKey?: string; terminalUserId?: string; maxAgeSec?: number; receivedAfter?: Date },
  client: ScanClient = db
): Promise<ConsumeResult> {
  try {
    const scan = await client.terminalScan.findUnique({ where: { scanId } });
    if (!scan) return { ok: false, reason: "NOT_FOUND", message: "رویداد اسکن یافت نشد." };
    if (expected?.deviceKey && scan.deviceKey !== expected.deviceKey) {
      return { ok: false, reason: "NOT_FOUND", message: "رویداد اسکن با دستگاه مطابقت ندارد." };
    }
    if (expected?.terminalUserId && scan.terminalUserId !== expected.terminalUserId) {
      return { ok: false, reason: "NOT_FOUND", message: "رویداد اسکن با کاربر دستگاه مطابقت ندارد." };
    }
    if (scan.usedAt) return { ok: false, reason: "ALREADY_USED", message: "این رویداد قبلاً مصرف شده است." };
    if (expected?.receivedAfter && scan.receivedAt < expected.receivedAfter) {
      return { ok: false, reason: "STALE", message: "این اسکن پیش از شروع درخواست دریافت شده است؛ دوباره اسکن کنید." };
    }
    const ageSec = (Date.now() - scan.receivedAt.getTime()) / 1000;
    const maxAge = expected?.maxAgeSec ?? 90;
    if (ageSec > maxAge || ageSec < -10) {
      return { ok: false, reason: "STALE", message: "رویداد اسکن کهنه است؛ لطفاً دوباره اسکن کنید." };
    }
    const identity = await resolveTerminalIdentity(scan.deviceKey, scan.terminalUserId);
    const updated = await client.terminalScan.updateMany({
      where: { scanId, usedAt: null },
      data: { usedAt: new Date(), importerId: identity?.importerId ?? null },
    });
    if (updated.count !== 1) return { ok: false, reason: "ALREADY_USED", message: "این رویداد قبلاً مصرف شده است." };
    return {
      ok: true,
      scan: {
        scanId: scan.scanId,
        terminalUserId: scan.terminalUserId,
        method: scan.method,
        deviceTime: scan.deviceTime,
        importerId: identity?.importerId ?? null,
      },
    };
  } catch (e) {
    console.error("[terminal-ingestion] consume failed", e);
    return { ok: false, reason: "ERROR", message: "مصرف رویداد اسکن ناموفق بود." };
  }
}

/** Release leases / scans left dangling when a device is disabled. */
export async function releaseDeviceLease(deviceKey: string): Promise<void> {
  await db.terminalLease.deleteMany({ where: { deviceKey } });
}

/** Opportunistic purge of expired replay/setup receipts (bounded growth). */
export async function purgeExpiredTerminalReceipts(): Promise<void> {
  await db.terminalReceipt.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 30 * 24 * 3600 * 1000) } } });
}
