import { ok, fail, requireUser, handleApiError, FriendlyApiError } from "@/lib/api";
import { assertPortAccess } from "@/lib/scope";
import { db } from "@/lib/db";
import { lanStageInfo, ensureLanSessionsRunning, startLanSession } from "@/lib/biometric/terminal-manager";
import { admsFeedStatus, ensureAdmsFeedRunning } from "@/lib/biometric/terminal-adms-feed";
import { resolveAdmsSettings, readConnectionProfile } from "@/lib/biometric/terminal-adms-server";
import { admsDeviceStatus } from "@/lib/biometric/terminal-adms-api";
import { normalizeSerial } from "@/lib/biometric/terminal-rules";

// ============================================================
// GET /api/biometric/terminal/status?deviceKey=<serial>
//
// Connection status with SEPARATE failure stages — a reachable TCP
// port is NOT the same as protocol authentication, matching serial
// or a successful realtime subscription, and an API health check is
// NOT the same as the terminal being online.
// ============================================================

export async function GET(request: Request) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  try {
    const { searchParams } = new URL(request.url);
    const serial = normalizeSerial(searchParams.get("deviceKey"));
    if (!serial) return fail("شناسه دستگاه نامعتبر است.");
    const device = await db.terminalDevice.findUnique({
      where: { serial },
      select: { serial: true, transport: true, isEnabled: true, checkpointId: true, host: true, port: true, lastSeenAt: true, model: true, timezoneOffsetMinutes: true },
    });
    if (!device) return fail("دستگاه مورد نظر یافت نشد.", 404);
    const denied = assertPortAccess(auth.user, device.checkpointId);
    if (denied) return fail(denied, 403);

    if (device.transport === "LAN") {
      const info = lanStageInfo(serial) ?? null;
      if (!info && device.isEnabled) {
        // lazily start the session on first use
        const started = await startLanSession(serial);
        return ok({
          device: { serial, transport: device.transport, isEnabled: device.isEnabled, lastSeenAt: device.lastSeenAt, model: device.model },
          connection: started,
        });
      }
      if (info && device.isEnabled && info.stage === "DISCONNECTED") ensureLanSessionsRunning();
      return ok({
        device: { serial, transport: device.transport, isEnabled: device.isEnabled, lastSeenAt: device.lastSeenAt, model: device.model },
        connection: info ?? { stage: "DISCONNECTED", stageError: null, detail: null },
      });
    }

    // ADMS_SERVER — read device status from the shared ADMS service
    const resolved = await resolveAdmsSettings();
    const feed = admsFeedStatus(serial);
    if (device.isEnabled && resolved.settings.readEnabled) ensureAdmsFeedRunning(serial);
    if (!resolved.apiUrl || !resolved.settings.readEnabled) {
      return ok({
        device: { serial, transport: device.transport, isEnabled: device.isEnabled, lastSeenAt: device.lastSeenAt, model: device.model },
        adms: { configured: false, readingEnabled: resolved.settings.readEnabled, feed },
        connection: { stage: "DISCONNECTED", stageError: "تنظیمات سرور ADMS کامل نیست.", detail: null },
      });
    }
    const deviceStatus = await admsDeviceStatus({
      apiUrl: resolved.apiUrl,
      serial,
      bearerToken: resolved.apiToken,
      caPem: readConnectionProfile(resolved.apiUrl).caPem,
      timeoutMs: 6000,
    });
    const integrationNote = !deviceStatus.ok && deviceStatus.httpStatus === 404
      ? "سرور در دسترس است، اما API وضعیت این دستگاه پاسخ 404 می‌دهد؛ مسیر API یا ثبت سریال در سرور باید بررسی شود. تنظیمات ذخیره‌شده به‌صورت خودکار استفاده می‌شود."
      : deviceStatus.ok ? null : deviceStatus.message;
    return ok({
      device: { serial, transport: device.transport, isEnabled: device.isEnabled, lastSeenAt: device.lastSeenAt, model: device.model },
      adms: {
        configured: true,
        readingEnabled: resolved.settings.readEnabled,
        serverReachable: deviceStatus.ok || deviceStatus.httpStatus !== undefined,
        apiReachable: deviceStatus.ok,
        apiHttpStatus: deviceStatus.ok ? 200 : deviceStatus.httpStatus ?? null,
        deviceOnline: deviceStatus.ok ? deviceStatus.status.online : false,
        deviceLastSeen: deviceStatus.ok ? deviceStatus.status.lastSeen : null,
        note: integrationNote,
        feed,
      },
      connection: {
        stage: deviceStatus.ok && deviceStatus.status.online ? "SUBSCRIBED" : "DISCONNECTED",
        stageError: deviceStatus.ok ? (deviceStatus.status.online ? null : "دستگاه در سرور ADMS آفلاین است.") : deviceStatus.message,
        detail: null,
      },
    });
  } catch (e) {
    if (e instanceof FriendlyApiError) return fail(e.message, 400);
    return handleApiError(e);
  }
}
