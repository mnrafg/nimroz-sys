import "server-only";
import net from "net";
import { db } from "@/lib/db";
import {
  CMD_ACK_DATA,
  CMD_ACK_OK,
  CMD_ACK_UNAUTH,
  CMD_CONNECT,
  CMD_AUTH,
  CMD_EXIT,
  CMD_OPTIONS_RRQ,
  CMD_REG_EVENT,
  encodeFrame,
  makeCommKey,
  optionsRequestPayload,
  parseLiveEventPayload,
  parseOptionsResponse,
  ProtocolError,
  tryDecodeFrame,
} from "./terminal-protocol";
import {
  LAN_CONNECT_TIMEOUT_MS,
  LAN_HEARTBEAT_MS,
  LAN_REPLY_TIMEOUT_MS,
  STAGE_MESSAGES,
  normalizeSerial,
  type TerminalStage,
  type TerminalStageInfo,
} from "./terminal-rules";
import { decryptTerminalSecret } from "./terminal-security";
import { ingestTerminalScan } from "./terminal-ingestion";

// ============================================================
// LAN terminal manager — the backend opens TCP to the terminal
// directly. Communication happens server-side ONLY (never browser
// TCP, no native SDK, no USB scanner required for the terminal).
//
// Session lifecycle:
//   connect → (comm-key auth when the terminal asks) → option read of
//   ~SerialNumber → serial verification → CMD_REG_EVENT subscription
//   → live events (each ACKed) with a ~20 s serial-verification
//   heartbeat → bounded disconnect/reconnect handling.
//
// Safety: user modification, template deletion, clock change, door
// control and device reset commands are NEVER sent.
// ============================================================

interface LanSession {
  serial: string;
  deviceDbId: number;
  host: string;
  port: number;
  commKey: string | null;
  timezoneOffsetMinutes: number;
  socket: net.Socket | null;
  stage: TerminalStage;
  completedStage: TerminalStage | null;
  stageError: string | null;
  detail: string | null;
  sessionId: number;
  replyId: number;
  buffer: Buffer;
  lastSeenAt: Date | null;
  connecting: boolean;
  reconnectTimer: NodeJS.Timeout | null;
  heartbeatTimer: NodeJS.Timeout | null;
  destroyed: boolean;
  pending: Map<number, { resolve: (frame: { cmd: number; payload: Buffer; sessionId: number }) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>;
  responseTimer: NodeJS.Timeout | null;
}

// One registry per Node worker, including development hot reloads.
type ManagerGlobal = typeof globalThis & {
  __aogcTerminalManager?: Map<string, LanSession>;
  __aogcTerminalManagerVersion?: number;
};
const g = globalThis as ManagerGlobal;
if (g.__aogcTerminalManager && g.__aogcTerminalManagerVersion !== 2) {
  for (const old of g.__aogcTerminalManager.values()) {
    old.destroyed = true;
    if (old.reconnectTimer) clearTimeout(old.reconnectTimer);
    if (old.heartbeatTimer) clearInterval(old.heartbeatTimer);
    old.socket?.destroy();
  }
  g.__aogcTerminalManager = undefined;
}
const sessions = g.__aogcTerminalManager ?? new Map<string, LanSession>();
g.__aogcTerminalManager = sessions;
g.__aogcTerminalManagerVersion = 2;

function stageInfo(s: LanSession): TerminalStageInfo {
  return { stage: s.stage, completedStage: s.completedStage, stageError: s.stageError, detail: s.detail };
}

function setStage(s: LanSession, stage: TerminalStage, error: string | null = null, detail: string | null = null) {
  s.stage = stage;
  s.stageError = error;
  s.detail = detail;
  if (stage === "CONNECTING") s.completedStage = null;
  if (["CONNECTED", "AUTHENTICATED", "SERIAL_VERIFIED", "SUBSCRIBED"].includes(stage)) s.completedStage = stage;
  if (stage === "SUBSCRIBED") s.lastSeenAt = new Date();
}

function replyIdNext(s: LanSession): number {
  s.replyId = (s.replyId + 1) % 0xffff;
  return s.replyId;
}

/** Send a frame and wait (bounded) for its reply. */
function sendRequest(
  s: LanSession,
  cmd: number,
  payload?: Buffer | string
): Promise<{ cmd: number; payload: Buffer; sessionId: number }> {
  return new Promise((resolve, reject) => {
    if (!s.socket || s.destroyed) return reject(new Error("اتصال برقرار نیست."));
    const replyId = replyIdNext(s);
    const frame = encodeFrame({ cmd, sessionId: s.sessionId, replyId, payload });
    const timer = setTimeout(() => {
      s.pending.delete(replyId);
      reject(new Error("پاسخ دستگاه در زمان مجاز نرسید."));
    }, LAN_REPLY_TIMEOUT_MS);
    s.pending.set(replyId, { resolve, reject, timer });
    s.socket.write(frame);
  });
}

function clearTimers(s: LanSession) {
  if (s.heartbeatTimer) clearTimeout(s.heartbeatTimer);
  s.heartbeatTimer = null;
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  s.reconnectTimer = null;
  if (s.responseTimer) clearTimeout(s.responseTimer);
  s.responseTimer = null;
}

function scheduleReconnect(s: LanSession, delayMs: number) {
  if (s.destroyed || s.reconnectTimer) return;
  s.reconnectTimer = setTimeout(() => {
    s.reconnectTimer = null;
    console.log(`[terminal-manager] reconnect tick serial=${s.serial}`);
    startLanSession(s.serial, true).catch((e) =>
      console.error(`[terminal-manager] reconnect failed serial=${s.serial}`, e)
    );
  }, delayMs);
}

function teardownSocket(s: LanSession, stageError: string | null, detail: string | null) {
  clearTimers(s);
  if (s.socket) {
    try {
      s.socket.destroy();
    } catch {
      // ignore
    }
    s.socket = null;
  }
  for (const pending of s.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(detail ?? STAGE_MESSAGES.DISCONNECTED));
  }
  s.pending.clear();
  if (!s.destroyed) {
    setStage(s, "DISCONNECTED", stageError, detail);
    scheduleReconnect(s, 5_000);
  }
}

function ackEvent(s: LanSession) {
  if (!s.socket) return;
  s.socket.write(encodeFrame({ cmd: CMD_ACK_OK, sessionId: s.sessionId, replyId: 0 }));
}

function handleData(s: LanSession, chunk: Buffer) {
  s.buffer = Buffer.concat([s.buffer, chunk]);
  if (s.buffer.length > 1024 * 1024) {
    teardownSocket(s, STAGE_MESSAGES.PROTOCOL_FAILED, "حجم داده دریافتی بیش از حد مجاز بود.");
    return;
  }
  // decode coalesced frames
  for (;;) {
    let frame;
    try {
      frame = tryDecodeFrame(s.buffer);
    } catch (e) {
      teardownSocket(s, STAGE_MESSAGES.PROTOCOL_FAILED, e instanceof Error ? e.message : "فریم نامعتبر.");
      return;
    }
    if (!frame) break; // fragmented — keep buffering
    s.buffer = s.buffer.subarray(frame.consumed);
    // Event packets can reuse reply IDs; they must never resolve commands.
    const pending = frame.cmd === CMD_REG_EVENT ? undefined : s.pending.get(frame.replyId);
    if (pending) {
      s.pending.delete(frame.replyId);
      clearTimeout(pending.timer);
      pending.resolve({ cmd: frame.cmd, payload: frame.payload, sessionId: frame.sessionId });
      continue;
    }
    // unsolicited realtime event frame
    // This firmware emits attendance events with sessionId=1, independently
    // of the command session. Trust the authenticated, serial-verified
    // socket, not that asynchronous event field.
    if (frame.cmd !== CMD_REG_EVENT || s.stage !== "SUBSCRIBED") continue;
    ackEvent(s);
    const events = parseLiveEventPayload(frame.payload);
    if (events.length > 0) {
      for (const ev of events) {
        void ingestTerminalScan({
          source: "LAN_LIVE",
          serial: s.serial,
          terminalUserId: ev.userId,
          punch: ev.punch,
          verify: ev.verify,
          deviceLocalMs: ev.deviceLocalMs,
          timezoneOffsetMinutes: s.timezoneOffsetMinutes,
        }).then((res) => {
          if (!res.ok) {
            console.warn(`[terminal-manager] scan rejected serial=${s.serial} reason=${res.reason}`);
          }
        }).catch((error) => console.error("[terminal-manager] scan ingestion failed", error));
      }
    } else if (frame.payload.length) {
      console.warn(`[terminal-manager] unsupported live event serial=${s.serial} bytes=${frame.payload.length}`);
    }
  }
}

/** Verify serial via ~SerialNumber option read (bounded reply). */
async function verifySerial(s: LanSession): Promise<boolean> {
  const reply = await sendRequest(s, CMD_OPTIONS_RRQ, optionsRequestPayload("SerialNumber"));
  if (reply.cmd !== CMD_ACK_OK && reply.cmd !== CMD_ACK_DATA) {
    s.stageError = STAGE_MESSAGES.PROTOCOL_FAILED;
    return false;
  }
  const opts = parseOptionsResponse(reply.payload);
  const reported = normalizeSerial(opts["SerialNumber"] ?? "");
  if (!reported || reported !== s.serial) {
    setStage(s, "FAILED", STAGE_MESSAGES.SERIAL_MISMATCH, reported ? `گزارش‌شده: ${reported}` : "سریالی گزارش نشد.");
    s.stageError = STAGE_MESSAGES.SERIAL_MISMATCH;
    return false;
  }
  if (s.stage !== "SUBSCRIBED") setStage(s, "SERIAL_VERIFIED");
  return true;
}

async function subscribeEvents(s: LanSession): Promise<boolean> {
  // EF_ATTLOG: successful attendance verification events only.
  const mask = Buffer.alloc(4);
  mask.writeUInt32LE(1, 0);
  const reply = await sendRequest(s, CMD_REG_EVENT, mask);
  if (reply.cmd !== CMD_ACK_OK) {
    setStage(s, "FAILED", STAGE_MESSAGES.SUBSCRIPTION_FAILED, null);
    s.stageError = STAGE_MESSAGES.SUBSCRIPTION_FAILED;
    return false;
  }
  setStage(s, "SUBSCRIBED");
  return true;
}

function startHeartbeat(s: LanSession) {
  s.heartbeatTimer = setInterval(() => {
    void (async () => {
      if (!s.socket || s.destroyed) return;
      try {
        const okSerial = await verifySerial(s);
        if (!okSerial) {
          teardownSocket(s, s.stageError ?? STAGE_MESSAGES.SERIAL_MISMATCH, "هارت‌بت سریال");
          return;
        }
        await db.terminalDevice.updateMany({ where: { serial: s.serial }, data: { lastSeenAt: new Date() } });
      } catch {
        teardownSocket(s, STAGE_MESSAGES.DISCONNECTED, "هارت‌بت ناموفق");
      }
    })();
  }, LAN_HEARTBEAT_MS);
}

async function handshake(s: LanSession): Promise<boolean> {
  // first connect — the terminal may answer CMD_ACK_UNAUTH when a
  // communication key is configured
  s.replyId = 0xfffe; // first on-wire reply id wraps to zero (pyzk)
  const first = await sendRequest(s, CMD_CONNECT);
  s.sessionId = first.sessionId || 0;
  if (first.cmd === CMD_ACK_UNAUTH) {
    if (!s.commKey) {
      s.stageError = STAGE_MESSAGES.AUTH_FAILED;
      setStage(s, "FAILED", STAGE_MESSAGES.AUTH_FAILED, "دستگاه کلید ارتباط می‌خواهد؛ کلید ذخیره نشده است.");
      return false;
    }
    const authReply = await sendRequest(s, CMD_AUTH, makeCommKey(s.commKey, s.sessionId));
    if (authReply.cmd !== CMD_ACK_OK) {
      setStage(s, "FAILED", STAGE_MESSAGES.AUTH_FAILED, null);
      s.stageError = STAGE_MESSAGES.AUTH_FAILED;
      return false;
    }
  } else if (first.cmd !== CMD_ACK_OK) {
    s.stageError = STAGE_MESSAGES.PROTOCOL_FAILED;
    setStage(s, "FAILED", STAGE_MESSAGES.PROTOCOL_FAILED, `کد پاسخ اتصال: ${first.cmd}`);
    return false;
  }
  setStage(s, "AUTHENTICATED");
  return true;
}

async function connectOnce(s: LanSession): Promise<void> {
  if (s.destroyed || s.connecting || s.socket) return;
  s.connecting = true;
  s.buffer = Buffer.alloc(0);
  setStage(s, "CONNECTING");
  try {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const sock = net.connect({ host: s.host, port: s.port });
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error("زمان اتصال به دستگاه پایان یافت."));
      }, LAN_CONNECT_TIMEOUT_MS);
      sock.once("connect", () => {
        clearTimeout(timer);
        resolve(sock);
      });
      sock.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    if (s.destroyed) { socket.destroy(); return; }
    s.socket = socket;
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => {
      if (!s.destroyed && s.socket === socket) handleData(s, chunk);
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (s.socket !== socket) return;
      teardownSocket(s, STAGE_MESSAGES.DISCONNECTED, `خطای سوکت: ${error.code ?? "UNKNOWN"}`);
    });
    socket.on("close", () => {
      if (!s.destroyed && s.socket === socket) teardownSocket(s, STAGE_MESSAGES.DISCONNECTED, null);
    });

    setStage(s, "CONNECTED");
    if (!(await handshake(s))) throw new ProtocolError(s.stageError ?? STAGE_MESSAGES.PROTOCOL_FAILED);
    if (!(await verifySerial(s))) throw new ProtocolError(s.stageError ?? STAGE_MESSAGES.SERIAL_MISMATCH);
    if (!(await subscribeEvents(s))) throw new ProtocolError(STAGE_MESSAGES.SUBSCRIPTION_FAILED);
    startHeartbeat(s);
    await db.terminalDevice.updateMany({ where: { serial: s.serial }, data: { lastSeenAt: new Date() } });
    console.log(`[terminal-manager] SUBSCRIBED serial=${s.serial} host=${s.host}:${s.port}`);
  } catch (e) {
    if (s.destroyed) return;
    const msg = e instanceof Error ? e.message : "اتصال ناموفق بود.";
    const isAuthOrSerial = s.stage === "FAILED";
    const failure = isAuthOrSerial ? s.stageError : s.completedStage ? STAGE_MESSAGES.PROTOCOL_FAILED : STAGE_MESSAGES.NETWORK_UNREACHABLE;
    setStage(s, "FAILED", failure, isAuthOrSerial ? (s.detail ?? msg) : msg);
    s.stageError = failure;
    clearTimers(s);
    if (s.socket) {
      try {
        s.socket.destroy();
      } catch {
        // ignore
      }
      s.socket = null;
    }
    console.error(`[terminal-manager] connect failed serial=${s.serial} err=${msg}`);
    scheduleReconnect(s, 10_000);
  } finally {
    s.connecting = false;
  }
}

/** Start (or refresh) the LAN session for a device. */
export async function startLanSession(serialInput: string, reconnectIfExisting = false): Promise<TerminalStageInfo> {
  const serial = normalizeSerial(serialInput);
  if (!serial) return { stage: "FAILED", stageError: "سریال نامعتبر است.", detail: null };
  const existing = sessions.get(serial);
  if (existing && !existing.destroyed && !reconnectIfExisting) return stageInfo(existing);
  const device = await db.terminalDevice.findUnique({ where: { serial } });
  if (!device || device.transport !== "LAN" || !device.isEnabled || !device.host || !device.port) {
    return { stage: "FAILED", stageError: "دستگاه LAN فعال با آدرس معتبر یافت نشد.", detail: null };
  }
  if (existing) {
    stopLanSession(serial);
    clearTimers(existing);
    existing.socket?.destroy();
    sessions.delete(serial);
  }
  const commKeyEnc = device.commKeyEnc;
  const session: LanSession = {
    serial,
    deviceDbId: device.id,
    host: device.host,
    port: device.port,
    commKey: commKeyEnc ? decryptTerminalSecret(commKeyEnc) : null,
    timezoneOffsetMinutes: device.timezoneOffsetMinutes,
    socket: null,
    stage: "CONNECTING",
    completedStage: null,
    stageError: null,
    detail: null,
    sessionId: 0,
    replyId: 0,
    buffer: Buffer.alloc(0),
    lastSeenAt: null,
    connecting: false,
    reconnectTimer: null,
    heartbeatTimer: null,
    destroyed: false,
    pending: new Map(),
    responseTimer: null,
  };
  sessions.set(serial, session);
  void connectOnce(session);
  return stageInfo(session);
}

export function stopLanSession(serialInput: string): void {
  const serial = normalizeSerial(serialInput);
  if (!serial) return;
  const s = sessions.get(serial);
  if (!s) return;
  s.destroyed = true;
  for (const pending of s.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error("اتصال دستگاه متوقف شد."));
  }
  s.pending.clear();
  clearTimers(s);
  if (s.socket) {
    // polite exit — bounded
    try {
      s.socket.write(encodeFrame({ cmd: CMD_EXIT, sessionId: s.sessionId, replyId: replyIdNext(s) }));
      s.socket.destroy();
    } catch {
      // ignore
    }
    s.socket = null;
  }
  sessions.delete(serial);
}

export function lanStageInfo(serialInput: string): TerminalStageInfo | null {
  const serial = normalizeSerial(serialInput);
  if (!serial) return null;
  const s = sessions.get(serial);
  return s ? stageInfo(s) : null;
}

export function ensureLanSessionsRunning(): void {
  void (async () => {
    try {
      const devices = await db.terminalDevice.findMany({ where: { transport: "LAN", isEnabled: true } });
      for (const d of devices) {
        const s = sessions.get(d.serial);
        if (!s || s.destroyed) void startLanSession(d.serial);
      }
    } catch (e) {
      console.error("[terminal-manager] ensure failed", e);
    }
  })();
}
