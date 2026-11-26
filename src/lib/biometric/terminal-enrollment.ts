import "server-only";
import { db } from "@/lib/db";
import { ENROLLMENT_TTL_SEC, isValidTerminalUserId, normalizeSerial } from "./terminal-rules";
import { consumeTerminalScan, purgeExpiredTerminalReceipts } from "./terminal-ingestion";
import { assertPortAccess, importerVisibilityWhere } from "@/lib/scope";
import type { SessionUser } from "@/lib/auth";
import { FriendlyApiError } from "@/lib/api";

// ============================================================
// Terminal enrollment — "confirming an on-device identity".
//
// The biometric methods (fingerprint/face/palm) are enrolled ON THE
// TERMINAL ITSELF by following the device's own menu. This module:
//   • starts a short-lived, owner-bound enrollment request
//   • matches ONE fresh scan for that device + terminal user id
//   • links DEVICE SERIAL + TERMINAL USER ID to the importer
//
// It NEVER captures templates remotely, never claims a two-finger
// enrollment was verified from one event, and never writes to the
// terminal.
// ============================================================

export const ENROLLMENT_MESSAGE = {
  START_INSTRUCTION:
    "کاربر مورد نظر را روی صفحه اصلی دستگاه ثبت و اثر بایومتریک او را از منوی خود دستگاه ثبت نمایید، سپس «انتظار برای اسکن تأیید» را فشار دهید تا فرد روی صفحه اصلی دستگاه تأیید شود.",
  WAIT_SCAN: "انتظار برای اسکن تأیید… فرد مورد نظر باید روی صفحه اصلی دستگاه تأیید شود.",
} as const;

export type EnrollStartInput = {
  importerId: number;
  deviceKey: string;
  terminalUserId: string;
};

export interface EnrollmentView {
  enrollmentId: string;
  deviceKey: string;
  terminalUserId: string;
  importerId: number;
  expiresAt: Date;
}
/**
 * Default proposed terminal user id: the EXISTING mapping for this
 * device when present, otherwise the importer's numeric id.
 */
export const TERMINAL_ID_LOCKED_MESSAGE =
  "شناسه کاربر این واردکننده روی این دستگاه قبلاً ثبت شده و قابل تغییر نیست؛ حتی مدیر سیستم نمی‌تواند آن را تغییر دهد.";

export async function terminalUserIdRegistration(deviceKey: string, importerId: number) {
  // Revocation disables a link, but never releases its permanent identity.
  const existing = await db.terminalIdentity.findUnique({
    where: { deviceKey_importerId: { deviceKey, importerId } },
    select: { terminalUserId: true },
  });
  return { terminalUserId: existing?.terminalUserId ?? String(importerId), locked: Boolean(existing) };
}

export async function proposedTerminalUserId(deviceKey: string, importerId: number): Promise<string> {
  return (await terminalUserIdRegistration(deviceKey, importerId)).terminalUserId;
}

export async function enrollmentRegistration(user: SessionUser, deviceKey: string, importerId: number) {
  const serial = normalizeSerial(deviceKey);
  if (!serial) throw new FriendlyApiError("سریال دستگاه نامعتبر است.");
  await assertImporterAccessible(user, importerId);
  await assertDeviceAccessible(user, serial);
  return terminalUserIdRegistration(serial, importerId);
}

async function assertImporterAccessible(user: SessionUser, importerId: number): Promise<void> {
  const importer = await db.importer.findFirst({
    where: { id: importerId },
    select: {
      id: true,
      status: true,
      membershipStatus: true,
      registeredCheckpointId: true,
      entries: { select: { checkpointId: true }, distinct: ["checkpointId"] },
      limits: { select: { checkpointId: true }, distinct: ["checkpointId"] },
    },
  });
  if (!importer) throw new FriendlyApiError("واردکننده مورد نظر یافت نشد.");
  if (importer.status !== "ACTIVE" || importer.membershipStatus !== "ACTIVE") {
    throw new FriendlyApiError("ثبت بایومتریک فقط برای واردکنندگان فعال امکان‌پذیر است.");
  }
  if (user.role !== "ADMIN") {
    const visible = importerVisibilityWhere(user);
    if (!visible) throw new FriendlyApiError("شما اجازه دسترسی به این واردکننده را ندارید.");
    const matches = await db.importer.findFirst({ where: { AND: [{ id: importerId }, visible] }, select: { id: true } });
    if (!matches) throw new FriendlyApiError("شما اجازه دسترسی به این واردکننده را ندارید.");
  }
  void assertPortAccess;
}

async function assertDeviceAccessible(user: SessionUser, serial: string): Promise<void> {
  const device = await db.terminalDevice.findUnique({ where: { serial }, select: { checkpointId: true, isEnabled: true } });
  if (!device) throw new FriendlyApiError("دستگاه مورد نظر یافت نشد.");
  if (!device.isEnabled) throw new FriendlyApiError("این دستگاه در سیستم فعال نیست.");
  const denied = assertPortAccess(user, device.checkpointId);
  if (denied) throw new FriendlyApiError(denied);
}

/** Start an enrollment request (conflicting simultaneous enrollments rejected). */
export async function startEnrollment(user: SessionUser, input: EnrollStartInput): Promise<EnrollmentView> {
  if (!isValidTerminalUserId(input.terminalUserId)) {
    throw new FriendlyApiError("شناسه کاربر دستگاه باید یک عدد مثبت با حداکثر ۹ رقم باشد.");
  }
  const serial = normalizeSerial(input.deviceKey);
  if (!serial) throw new FriendlyApiError("سریال دستگاه نامعتبر است.");
  await assertImporterAccessible(user, input.importerId);
  await assertDeviceAccessible(user, serial);

  // mapping-conflict checks
  const identityAtUser = await db.terminalIdentity.findUnique({
    where: { deviceKey_terminalUserId: { deviceKey: serial, terminalUserId: input.terminalUserId } },
    select: { importerId: true, revokedAt: true },
  });
  if (identityAtUser && identityAtUser.importerId !== input.importerId) {
    throw new FriendlyApiError(
      "این شناسه کاربر روی این دستگاه از قبل به واردکننده دیگری پیوند خورده است."
    );
  }
  const identityAtImporter = await db.terminalIdentity.findUnique({
    where: { deviceKey_importerId: { deviceKey: serial, importerId: input.importerId } },
    select: { terminalUserId: true, revokedAt: true },
  });
  if (identityAtImporter && identityAtImporter.terminalUserId !== input.terminalUserId) {
    throw new FriendlyApiError(
      TERMINAL_ID_LOCKED_MESSAGE
    );
  }

  // prevent conflicting simultaneous enrollments (same device+user)
  const now = new Date();
  const conflicts = await db.terminalEnrollment.findMany({
    where: { deviceKey: serial, terminalUserId: input.terminalUserId, status: "PENDING", expiresAt: { gt: now } },
    select: { id: true, ownerId: true },
  });
  for (const c of conflicts) {
    if (c.ownerId !== user.id) {
      throw new FriendlyApiError("برای این دستگاه و شناسه کاربر، درخواست ثبت فعال دیگری وجود دارد.");
    }
  }
  // cancel stale pending requests owned by this user
  await db.terminalEnrollment.updateMany({
    where: { ownerId: user.id, status: "PENDING" },
    data: { status: "CANCELED" },
  });

  const expiresAt = new Date(now.getTime() + ENROLLMENT_TTL_SEC * 1000);
  const enrollment = await db.terminalEnrollment.create({
    data: {
      deviceKey: serial,
      terminalUserId: input.terminalUserId,
      importerId: input.importerId,
      ownerId: user.id,
      expiresAt,
    },
    select: { id: true, deviceKey: true, terminalUserId: true, importerId: true, expiresAt: true },
  });
  return {
    enrollmentId: enrollment.id,
    deviceKey: enrollment.deviceKey,
    terminalUserId: enrollment.terminalUserId,
    importerId: enrollment.importerId,
    expiresAt: enrollment.expiresAt,
  };
}

export type CompleteResult =
  | {
      ok: true;
      identity: { deviceKey: string; terminalUserId: string; importerId: number; method: string };
      created: boolean;
    }
  | { ok: false; message: string };

/**
 * Complete an enrollment atomically: verify device/user, freshness,
 * ownership and single-use; consume the scan; link the identity;
 * complete the request; update importer biometric status; audit.
 *
 * Scan consumption happens INSIDE the transaction — if identity linking
 * fails (mapping conflict, DB error) the scan is NOT burned and can be
 * used again by a retry.
 */
export async function completeEnrollment(user: SessionUser, enrollmentId: string, scanId: string): Promise<CompleteResult> {
  const enrollment = await db.terminalEnrollment.findUnique({
    where: { id: enrollmentId },
    include: { device: { select: { isEnabled: true } } },
  });
  if (!enrollment) return { ok: false, message: "درخواست ثبت یافت نشد." };
  if (enrollment.ownerId !== user.id) return { ok: false, message: "این درخواست متعلق به نشست شما نیست." };
  if (enrollment.status === "EXPIRED" || enrollment.expiresAt.getTime() < Date.now()) {
    if (enrollment.status === "PENDING") {
      await db.terminalEnrollment.update({ where: { id: enrollmentId }, data: { status: "EXPIRED" } });
    }
    return { ok: false, message: "زمان درخواست ثبت پایان یافته است؛ دوباره شروع کنید." };
  }
  if (enrollment.status !== "PENDING") return { ok: false, message: "این درخواست تکمیل یا لغو شده است." };
  if (!enrollment.device.isEnabled) return { ok: false, message: "این دستگاه در سیستم فعال نیست." };

  // A scan-refusal inside the transaction must abort it without burning
  // anything — surfaced through this typed error.
  class ScanRefusal extends Error {
    constructor(public readonly message2: string) {
      super(message2);
    }
  }

  try {
    const result = await db.$transaction(async (tx) => {
      const registration = await tx.terminalIdentity.findUnique({
        where: { deviceKey_importerId: { deviceKey: enrollment.deviceKey, importerId: enrollment.importerId } },
        select: { terminalUserId: true },
      });
      if (registration && registration.terminalUserId !== enrollment.terminalUserId) {
        throw new ScanRefusal(TERMINAL_ID_LOCKED_MESSAGE);
      }
      // atomic single-use consumption with exact device+user pinning —
      // rolled back together with the identity write on any failure
      const consumed = await consumeTerminalScan(
        scanId,
        { deviceKey: enrollment.deviceKey, terminalUserId: enrollment.terminalUserId, receivedAfter: enrollment.createdAt },
        tx
      );
      if (!consumed.ok) throw new ScanRefusal(consumed.message);
      const method = consumed.scan.method;

      // A device maps each importer to exactly ONE terminal user id —
      // upsert on the (deviceKey, importerId) slot keeps that invariant.
      // A (deviceKey, terminalUserId) slot held by ANOTHER importer
      // triggers a unique violation → reported as a mapping conflict.
      const identity = await tx.terminalIdentity.upsert({
        where: { deviceKey_importerId: { deviceKey: enrollment.deviceKey, importerId: enrollment.importerId } },
        create: {
          deviceKey: enrollment.deviceKey,
          terminalUserId: enrollment.terminalUserId,
          importerId: enrollment.importerId,
          method,
        },
        // Never UPDATE terminalUserId: the first confirmed mapping is permanent.
        update: { method, revokedAt: null, enrolledAt: new Date() },
      });
      // A competing confirmation may have inserted the slot since the read.
      if (identity.terminalUserId !== enrollment.terminalUserId) {
        throw new ScanRefusal(TERMINAL_ID_LOCKED_MESSAGE);
      }
      await tx.terminalEnrollment.update({
        where: { id: enrollmentId },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
      await tx.importer.update({
        where: { id: enrollment.importerId },
        data: { biometricStatus: "ENROLLED", biometricEnrolledAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: "TERMINAL_ENROLL_COMPLETED",
          recordType: "TerminalIdentity",
          recordId: identity.id,
          newValues: JSON.stringify({
            deviceKey: enrollment.deviceKey,
            terminalUserId: enrollment.terminalUserId,
            importerId: enrollment.importerId,
            method,
            scanId: consumed.scan.scanId,
          }),
        },
      });
      return identity;
    });
    return {
      ok: true,
      identity: {
        deviceKey: result.deviceKey,
        terminalUserId: result.terminalUserId,
        importerId: result.importerId,
        method: result.method ?? "FINGERPRINT",
      },
      created: true,
    };
  } catch (e) {
    if (e instanceof ScanRefusal) return { ok: false, message: e.message2 };
    const msg = e instanceof Error ? e.message : "";
    if (msg.includes("Unique constraint")) {
      return { ok: false, message: "این شناسه کاربر روی این دستگاه به واردکننده دیگری تعلق دارد." };
    }
    console.error("[terminal-enrollment] completion failed", e);
    return { ok: false, message: "تکمیل ثبت ناموفق بود؛ لطفاً دوباره تلاش کنید." };
  }
}

export async function cancelEnrollment(user: SessionUser, enrollmentId: string): Promise<{ ok: boolean; message: string }> {
  const enrollment = await db.terminalEnrollment.findUnique({ where: { id: enrollmentId }, select: { ownerId: true, status: true } });
  if (!enrollment) return { ok: false, message: "درخواست ثبت یافت نشد." };
  if (enrollment.ownerId !== user.id) return { ok: false, message: "این درخواست متعلق به نشست شما نیست." };
  if (enrollment.status !== "PENDING") return { ok: false, message: "این درخواست تکمیل یا لغو شده است." };
  await db.terminalEnrollment.update({ where: { id: enrollmentId }, data: { status: "CANCELED" } });
  return { ok: true, message: "درخواست ثبت لغو شد." };
}

/** Lazy sweep: expire stale PENDING requests + purge old receipts (called on access paths). */
export async function expireStaleEnrollments(): Promise<void> {
  await db.terminalEnrollment.updateMany({
    where: { status: "PENDING", expiresAt: { lte: new Date() } },
    data: { status: "EXPIRED" },
  });
  await purgeExpiredTerminalReceipts();
}

/** Latest fresh scan for an active enrollment (SSE helper). */
export async function latestEnrollmentScan(
  enrollment: { deviceKey: string; terminalUserId: string; createdAt: Date },
  afterCursor: number,
  includeOtherUsers = false
): Promise<{ scanId: string; terminalUserId: string; method: string; deviceTime: Date; cursor: number } | null> {
  const scan = await db.terminalScan.findFirst({
    where: {
      deviceKey: enrollment.deviceKey,
      ...(includeOtherUsers ? {} : { terminalUserId: enrollment.terminalUserId }),
      id: { gt: afterCursor },
      usedAt: null,
      receivedAt: { gte: new Date(Math.max(enrollment.createdAt.getTime(), Date.now() - 90_000)) },
    },
    orderBy: { id: "asc" },
    select: { id: true, scanId: true, terminalUserId: true, method: true, deviceTime: true, receivedAt: true },
  });
  if (!scan) return null;
  const ageSec = (Date.now() - scan.receivedAt.getTime()) / 1000;
  if (ageSec > 90 || ageSec < -10) return null; // stale — not eligible
  return { scanId: scan.scanId, terminalUserId: scan.terminalUserId, method: scan.method, deviceTime: scan.deviceTime, cursor: scan.id };
}

