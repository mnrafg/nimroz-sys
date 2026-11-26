import "server-only";
import { db } from "@/lib/db";
import { encryptTerminalSecret as encrypt } from "./terminal-security";
import { normalizeSerial, TERMINAL_TRANSPORTS, type TerminalTransport } from "./terminal-rules";
import { releaseDeviceLease } from "./terminal-ingestion";
import { stopLanSession } from "./terminal-manager";
import { resetAdmsFeed } from "./terminal-adms-feed";
import { assertPortAccess, requirePortScope } from "@/lib/scope";
import { FriendlyApiError } from "@/lib/api";
import type { SessionUser } from "@/lib/auth";

// ============================================================
// Terminal device administration (ADMIN-configured; port-scoped).
//  • serial is the stable primary identity and immutable on edit
//  • disabling a device stops application use and releases its
//    active scan lease — it never locks or disables the physical
//    terminal
//  • switching a terminal between LAN and ADMS keeps all identity
//    mappings because the serial never changes
// ============================================================

export interface TerminalDeviceInput {
  name: string;
  transport: TerminalTransport;
  serial: string;
  checkpointId: number;
  host?: string | null;
  port?: number | null;
  timezoneOffsetMinutes?: number | null;
  allowedNetworks?: string | null;
  commKey?: string | null;
}

const HOST_RE = /^[a-zA-Z0-9._-]{1,253}$/;
const CIDR_RE = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;

function validateCommon(input: TerminalDeviceInput): { serial: string; commKey: string | null } {
  const serial = normalizeSerial(input.serial);
  if (!serial) throw new FriendlyApiError("شماره سریال دستگاه نامعتبر است (۴ تا ۶۴ کاراکتر).");
  if (!input.name || input.name.trim().length < 2 || input.name.length > 80) {
    throw new FriendlyApiError("نام دستگاه باید بین ۲ تا ۸۰ کاراکتر باشد.");
  }
  if (!Number.isInteger(input.checkpointId) || input.checkpointId <= 0) {
    throw new FriendlyApiError("بندر دستگاه باید تعیین شود.");
  }
  if (input.timezoneOffsetMinutes !== undefined && input.timezoneOffsetMinutes !== null) {
    const off = input.timezoneOffsetMinutes;
    if (!Number.isInteger(off) || off < -720 || off > 840) {
      throw new FriendlyApiError("اختلاف ساعت دستگاه نامعتبر است.");
    }
  }
  if (input.allowedNetworks) {
    for (const part of input.allowedNetworks.split(",")) {
      const v = part.trim();
      if (v && !CIDR_RE.test(v)) throw new FriendlyApiError("قالب شبکه مجاز (CIDR) نامعتبر است.");
    }
  }
  const commKey = input.commKey?.trim() || null;
  if (commKey && !/^\d{1,10}$/.test(commKey)) {
    throw new FriendlyApiError("کلید ارتباط دستگاه باید فقط رقم باشد.");
  }
  return { serial, commKey };
}

function validateLanFields(input: TerminalDeviceInput): { host: string; port: number } {
  const host = (input.host ?? "").trim();
  const port = input.port ?? 4370;
  if (!host || !HOST_RE.test(host)) {
    throw new FriendlyApiError("برای اتصال شبکه محلی، آدرس IP یا نام میزبان دستگاه لازم است.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new FriendlyApiError("پورت TCP دستگاه نامعتبر است.");
  }
  return { host, port };
}

/** List devices within the caller's scope (ADMIN: all / OFFICER: own port). */
export async function listTerminalDevices(user: SessionUser) {
  const scope = requirePortScope(user);
  if (!scope.ok) throw new FriendlyApiError(scope.message);
  const where =
    scope.scope.kind === "all" ? {} : scope.scope.kind === "port" ? { checkpointId: scope.scope.checkpointId } : {};
  return db.terminalDevice.findMany({
    where,
    orderBy: { id: "asc" },
    select: {
      id: true,
      serial: true,
      name: true,
      transport: true,
      host: true,
      port: true,
      checkpointId: true,
      checkpoint: { select: { id: true, name: true } },
      isEnabled: true,
      timezoneOffsetMinutes: true,
      lastSeenAt: true,
      model: true,
      allowedNetworks: true,
      commKeySet: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

/** Create a device (ADMIN only). */
export async function createTerminalDevice(user: SessionUser, input: TerminalDeviceInput) {
  const { serial, commKey } = validateCommon(input);
  const denied = assertPortAccess(user, input.checkpointId);
  if (denied) throw new FriendlyApiError(denied);
  if (input.transport === "LAN") {
    const { host, port } = validateLanFields(input);
    return db.terminalDevice.create({
      data: {
        serial,
        name: input.name.trim(),
        transport: "LAN",
        host,
        port,
        checkpointId: input.checkpointId,
        timezoneOffsetMinutes: input.timezoneOffsetMinutes ?? 270,
        allowedNetworks: input.allowedNetworks ?? null,
        commKeyEnc: commKey ? encrypt(commKey) : null,
        commKeySet: !!commKey,
        createdById: user.id,
      },
    });
  }
  // ADMS_SERVER — a LAN IP is never requested; identified by serial
  return db.terminalDevice.create({
    data: {
      serial,
      name: input.name.trim(),
      transport: "ADMS_SERVER",
      host: null,
      port: null,
      checkpointId: input.checkpointId,
      timezoneOffsetMinutes: input.timezoneOffsetMinutes ?? 270,
      allowedNetworks: input.allowedNetworks ?? null,
      commKeyEnc: commKey ? encrypt(commKey) : null,
      commKeySet: !!commKey,
      createdById: user.id,
    },
  });
}

/** Update an existing device (ADMIN only). Serial is immutable. */
export async function updateTerminalDevice(user: SessionUser, id: number, input: TerminalDeviceInput) {
  const { commKey } = validateCommon(input);
  const existing = await db.terminalDevice.findUnique({ where: { id } });
  if (!existing) throw new FriendlyApiError("دستگاه مورد نظر یافت نشد.");
  const denied = assertPortAccess(user, input.checkpointId);
  if (denied) throw new FriendlyApiError(denied);
  if (!TERMINAL_TRANSPORTS.includes(input.transport)) {
    throw new FriendlyApiError("روش اتصال نامعتبر است.");
  }
  // explicit administrator action when editing a legacy/unsupported transport
  if (existing.transport !== "LAN" && existing.transport !== "ADMS_SERVER" && existing.transport !== input.transport) {
    throw new FriendlyApiError("انتقال ذخیره‌شده قدیمی است؛ انتخاب صریح روش اتصال ضروری است.");
  }
  const transportChanged = existing.transport !== input.transport;
  const data: Record<string, unknown> = {
    name: input.name.trim(),
    transport: input.transport,
    checkpointId: input.checkpointId,
    timezoneOffsetMinutes: input.timezoneOffsetMinutes ?? existing.timezoneOffsetMinutes,
    allowedNetworks: input.allowedNetworks ?? null,
  };
  if (commKey) {
    data.commKeyEnc = encrypt(commKey);
    data.commKeySet = true;
  }
  if (input.transport === "LAN") {
    const { host, port } = validateLanFields(input);
    data.host = host;
    data.port = port;
  } else {
    // ADMS identifies the terminal by serial — no LAN address is kept
    data.host = null;
    data.port = null;
  }
  const updated = await db.terminalDevice.update({ where: { id }, data });
  if (transportChanged || !updated.isEnabled || existing.host !== updated.host || existing.port !== updated.port ||
      existing.timezoneOffsetMinutes !== updated.timezoneOffsetMinutes || !!commKey) {
    // transport switch and disabled devices stop participating entirely:
    // release any lease AND tear down live transport sessions/feeds
    // (mappings are preserved — keyed by serial)
    await releaseDeviceLease(existing.serial);
    stopLanSession(existing.serial);
    resetAdmsFeed(existing.serial);
  }
  return updated;
}

/** Enable/disable (application-level only — never physically locks the terminal). */
export async function setTerminalDeviceEnabled(user: SessionUser, id: number, isEnabled: boolean) {
  const existing = await db.terminalDevice.findUnique({ where: { id } });
  if (!existing) throw new FriendlyApiError("دستگاه مورد نظر یافت نشد.");
  const denied = assertPortAccess(user, existing.checkpointId);
  if (denied) throw new FriendlyApiError(denied);
  const updated = await db.terminalDevice.update({ where: { id }, data: { isEnabled } });
  if (!isEnabled) {
    await releaseDeviceLease(existing.serial);
    stopLanSession(existing.serial);
    resetAdmsFeed(existing.serial);
  }
  return updated;
}
