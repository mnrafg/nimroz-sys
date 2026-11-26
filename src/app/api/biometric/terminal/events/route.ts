import { fail, requireUser } from "@/lib/api";
import { db } from "@/lib/db";
import { assertPortAccess } from "@/lib/scope";
import { normalizeSerial, LEASE_TTL_SEC, LEASE_RENEWAL_MS, SCAN_POLL_MS, isValidTerminalUserId } from "@/lib/biometric/terminal-rules";
import { latestEnrollmentScan } from "@/lib/biometric/terminal-enrollment";
import { ensureLanSessionsRunning, startLanSession } from "@/lib/biometric/terminal-manager";
import { ensureAdmsFeedRunning } from "@/lib/biometric/terminal-adms-feed";
import { resolveTerminalIdentity } from "@/lib/biometric/terminal-ingestion";
import type { SessionUser } from "@/lib/auth";

// ============================================================
// GET /api/biometric/terminal/events  (Server-Sent Events)
//
//   ?deviceKey=<serial>    → live identification stream
//   ?enrollmentId=<uuid>   → enrollment confirmation stream
//
// Reference behavior reproduced:
//  • database-backed EXCLUSIVE lease per terminal (~25 s), renewed
//    around every 8 s with authorization refresh
//  • scan polling around every 400 ms from the durable DB cursor
//  • stream starts at the CURRENT cursor — old scans never replay
//  • events: status / heartbeat / notice / enrollment-scan /
//    identified / expired
//  • only the lease holder may consume a scan; delivery consumes it
//    exactly once (durable, works across application workers — an
//    in-memory bus is never used for delivery)
// ============================================================

export const dynamic = "force-dynamic";

function sseChunk(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function currentImporterSummary(importerId: number) {
  const importer = await db.importer.findUnique({
    where: { id: importerId },
    select: {
      id: true,
      importerCode: true,
      name: true,
      fatherName: true,
      companyName: true,
      idCardNumber: true,
      phone: true,
      importerType: true,
      status: true,
      membershipStatus: true,
      biometricStatus: true,
      registeredCheckpointId: true,
      photoData: true,
    },
  });
  return importer;
}

async function acquireLease(deviceKey: string, user: SessionUser, sessionId: string): Promise<{ ok: boolean; holderSession?: string; ownerName?: string }> {
  const now = new Date();
  // release abandoned leases lazily
  await db.terminalLease.deleteMany({ where: { deviceKey, expiresAt: { lte: now } } });
  const existing = await db.terminalLease.findUnique({ where: { deviceKey }, include: { owner: { select: { name: true } } } });
  if (existing) {
    if (existing.ownerId === user.id) {
      // same owner reconnecting with a different tab → take over cleanly.
      // Conditional delete (ownerId-bound) keeps takeover atomic even if
      // another tab of the same owner reconnects at the same moment.
      await db.terminalLease.deleteMany({ where: { deviceKey, ownerId: user.id } });
    } else {
      return { ok: false, holderSession: existing.sessionId, ownerName: existing.owner.name };
    }
  }
  await db.terminalLease.create({
    data: { deviceKey, sessionId, ownerId: user.id, expiresAt: new Date(now.getTime() + LEASE_TTL_SEC * 1000) },
  });
  return { ok: true };
}

export async function GET(request: Request) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  const user = auth.user;
  const { searchParams } = new URL(request.url);
  const enrollmentId = searchParams.get("enrollmentId");
  const deviceKeyParam = searchParams.get("deviceKey");
  const encoder = new TextEncoder();

  let deviceKey: string;
  let enrollment: { id: string; deviceKey: string; terminalUserId: string; expiresAt: Date; status: string; importerId: number; createdAt: Date } | null = null;
  /** Declared OUTSIDE the setup try-block: the SSE stream callbacks below
   *  read device.transport/... long after setup finished. A block-scoped
   *  const here would throw ReferenceError inside the stream at runtime
   *  (a latent crash on every live-identification connection). */
  let device: { serial: string; transport: string; isEnabled: boolean; checkpointId: number; timezoneOffsetMinutes: number };

  try {
    if (enrollmentId) {
      const found = await db.terminalEnrollment.findUnique({
        where: { id: enrollmentId },
        select: { id: true, deviceKey: true, terminalUserId: true, expiresAt: true, status: true, importerId: true, ownerId: true, createdAt: true },
      });
      if (!found) return fail("درخواست ثبت یافت نشد.", 404);
      if (found.ownerId !== user.id) return fail("این درخواست متعلق به نشست شما نیست.", 403);
      enrollment = found;
      deviceKey = found.deviceKey;
    } else {
      const serial = normalizeSerial(deviceKeyParam);
      if (!serial) return fail("شناسه دستگاه نامعتبر است.");
      deviceKey = serial;
    }

    const foundDevice = await db.terminalDevice.findUnique({
      where: { serial: deviceKey },
      select: { serial: true, transport: true, isEnabled: true, checkpointId: true, timezoneOffsetMinutes: true },
    });
    if (!foundDevice) return fail("دستگاه مورد نظر یافت نشد.", 404);
    if (!foundDevice.isEnabled) return fail("این دستگاه در سیستم فعال نیست.", 400);
    const denied = assertPortAccess(user, foundDevice.checkpointId);
    if (denied) return fail(denied, 403);
    device = foundDevice;
  } catch (setupError) {
    // stream setup failures (DB hiccup, lease-create race) MUST surface as
    // a real error — never as an empty/hanging stream (spec §2)
    console.error("[terminal-events] setup failed", setupError);
    return fail("برقراری جریان رویدادهای زنده ناموفق بود؛ لطفاً دوباره تلاش کنید.", 500);
  }

  const sessionId = `${user.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let lease: Awaited<ReturnType<typeof acquireLease>>;
  try {
    lease = await acquireLease(deviceKey, user, sessionId);
  } catch (leaseError) {
    console.error("[terminal-events] lease acquisition failed", leaseError);
    return fail("تخصیص دستگاه ناموفق بود؛ لطفاً دوباره تلاش کنید.", 500);
  }
  if (!lease.ok) {
    // exclusive lease held by another workstation — short notice stream
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `event: notice\ndata: ${JSON.stringify({
              kind: "LEASE_BUSY",
              message: `این دستگاه در حال حاضر در ترمینال دیگری (${lease.ownerName}) در حال استفاده است.`,
            })}\n\n`
          )
        );
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" },
    });
  }

  const cursorStart = await db.terminalScan.findFirst({ where: { deviceKey, ...(enrollment ? { receivedAt: { lt: enrollment.createdAt } } : {}) }, orderBy: { id: "desc" }, select: { id: true } });
  let cursor = cursorStart?.id ?? 0;
  let closed = false;
  let lastRenewal = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      send("status", {
        deviceKey,
        transport: device.transport,
        sessionId,
        mode: enrollment ? "enrollment" : "identification",
        terminalUserId: enrollment?.terminalUserId ?? null,
        message: enrollment ? "انتظار برای اسکن تأیید…" : "اتصال زنده فعال است؛ دستگاه آماده شناسایی است.",
      });

      // keep the transport awake while in use
      if (device.transport === "LAN") void startLanSession(deviceKey);
      else if (device.transport === "ADMS_SERVER") ensureAdmsFeedRunning(deviceKey);

      const renew = async () => {
        if (closed) return;
        const now = Date.now();
        if (now - lastRenewal >= LEASE_RENEWAL_MS) {
          lastRenewal = now;
          const held = await db.terminalLease.findUnique({ where: { deviceKey }, select: { sessionId: true, expiresAt: true } });
          if (!held || held.sessionId !== sessionId) {
            send("notice", { kind: "LEASE_LOST", message: "دستگاه به ترمینال دیگری تخصیص یافت." });
            closed = true;
            controller.close();
            return;
          }
          await db.terminalLease.update({
            where: { deviceKey },
            data: { expiresAt: new Date(now + LEASE_TTL_SEC * 1000) },
          });
          // authorization refresh during long-lived streams
          const freshUser = await db.user.findUnique({
            where: { id: user.id },
            select: { isActive: true, checkpointId: true, role: true },
          });
          if (!freshUser?.isActive) {
            send("notice", { kind: "AUTH_LOST", message: "نشست شما دیگر فعال نیست." });
            closed = true;
            controller.close();
            return;
          }
          if (device.transport === "LAN") void startLanSession(deviceKey);
          else if (device.transport === "ADMS_SERVER") ensureAdmsFeedRunning(deviceKey);
        }
      };

      const tick = async () => {
        if (closed) return;
        try {
          await renew();
          if (enrollment) {
            if (enrollment.status === "PENDING" && enrollment.expiresAt.getTime() < Date.now()) {
              await db.terminalEnrollment.update({ where: { id: enrollment.id }, data: { status: "EXPIRED" } });
              send("expired", { enrollmentId: enrollment.id, message: "زمان درخواست ثبت پایان یافت." });
              closed = true;
              controller.close();
              return;
            }
            const scan = await latestEnrollmentScan(
              // the enrollment's REAL creation time — a scan received
              // BEFORE the request started can never confirm it
              { deviceKey: enrollment.deviceKey, terminalUserId: enrollment.terminalUserId, createdAt: enrollment.createdAt },
              cursor,
              true // also report fresh scans belonging to a different user
            );
            if (scan) {
              cursor = Math.max(cursor, scan.cursor);
              if (scan.terminalUserId !== enrollment.terminalUserId) {
                send("notice", {
                  kind: "ENROLLMENT_USER_MISMATCH",
                  message: "اسکن دریافت شد، اما شناسه کاربر دستگاه با شناسه واردشده در این فرم مطابقت ندارد. لطفاً شخص مورد نظر دوباره اسکن کند یا شناسه کاربر را اصلاح کنید.",
                });
                return; // never consume or link a different person’s scan
              }
              send("enrollment-scan", {
                enrollmentId: enrollment.id,
                scanId: scan.scanId,
                terminalUserId: scan.terminalUserId,
                method: scan.method,
                deviceTime: scan.deviceTime,
              });
            }
          } else {
            const scans = await db.terminalScan.findMany({
              where: { deviceKey, id: { gt: cursor } },
              orderBy: { id: "asc" },
              take: 10,
              select: { id: true, scanId: true, terminalUserId: true, method: true, deviceTime: true, usedAt: true, verifyMode: true },
            });
            for (const scan of scans) {
              cursor = Math.max(cursor, scan.id);
              if (scan.usedAt) continue; // consumed elsewhere
              if (!isValidTerminalUserId(scan.terminalUserId)) continue;
              // resolve BEFORE consuming so the mapping can be recorded on
              // the scan row itself (delivery-time attribution)
              const identity = await resolveTerminalIdentity(deviceKey, scan.terminalUserId);
              // single-use consumption by the lease holder, atomically
              const consumed = await db.terminalScan.updateMany({
                where: { id: scan.id, usedAt: null },
                data: { usedAt: new Date(), importerId: identity?.importerId ?? null },
              });
              if (consumed.count !== 1) continue;
              if (!identity) {
                send("notice", {
                  kind: "UNMAPPED_SCAN",
                  terminalUserId: scan.terminalUserId,
                  method: scan.method,
                  message: "این شناسه کاربر به هیچ واردکننده‌ای پیوند نخورده است.",
                });
                continue;
              }
              const importer = await currentImporterSummary(identity.importerId);
              if (!importer) {
                // mapped but inaccessible (deleted/inactive) — surfaced
                // honestly instead of a silent discard
                send("notice", {
                  kind: "UNAVAILABLE_IMPORTER",
                  terminalUserId: scan.terminalUserId,
                  method: scan.method,
                  message: "واردکننده مرتبط با این شناسه فعال نیست یا در دسترس نیست.",
                });
                continue;
              }
              send("identified", {
                scanId: scan.scanId,
                deviceKey,
                terminalUserId: scan.terminalUserId,
                method: scan.method,
                deviceTime: scan.deviceTime,
                importer,
              });
            }
          }
        } catch (e) {
          console.error("[terminal-events] tick failed", e);
        }
      };

      const pollTimer = setInterval(() => void tick(), SCAN_POLL_MS);
      const heartbeatTimer = setInterval(() => send("heartbeat", { at: Date.now() }), 15_000);

      const cleanup = () => {
        clearInterval(pollTimer);
        clearInterval(heartbeatTimer);
        closed = true;
        // release the lease on disconnect where possible
        void (async () => {
          try {
            const held = await db.terminalLease.findUnique({ where: { deviceKey }, select: { sessionId: true } });
            if (held?.sessionId === sessionId) await db.terminalLease.delete({ where: { deviceKey } });
          } catch {
            // abandoned leases expire safely
          }
        })();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      request.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
