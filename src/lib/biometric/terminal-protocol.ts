import "server-only";
import { parseDeviceLocalTimestamp } from "./terminal-rules";

// ZKTeco standalone TCP protocol. Wire layout and command values follow
// pyzk zk/base.py and zk/const.py; hardware handshake verified separately.
export const PROTOCOL_TAG = 0x5050;
export const TCP_MAGIC = 0x7d82;
export const CMD_CONNECT = 1000;
export const CMD_EXIT = 1001;
export const CMD_AUTH = 1102;
export const CMD_ENABLEDEVICE = 1002;
export const CMD_DISABLEDEVICE = 1003;
export const CMD_OPTIONS_RRQ = 11;
export const CMD_OPTIONS_WRQ = 12;
export const CMD_REG_EVENT = 500;
export const CMD_ACK_OK = 2000;
export const CMD_ACK_ERROR = 2001;
export const CMD_ACK_DATA = 2002;
export const CMD_ACK_UNAUTH = 2005;
export const CMD_ACK_UNKNOWN = 65535;
export const CMD_ACK_RETRY = 2003;
export const CMD_ACK_REPEAT = 2004;
export const MAX_FRAME_BYTES = 256 * 1024;
export const ZK_HEADER_SIZE = 8;

/** One's-complement checksum over the final command header and payload. */
export function protocolChecksum(buf: Buffer): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 2) {
    sum += buf[i] + ((buf[i + 1] ?? 0) << 8);
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  while (sum >>> 16) sum = (sum & 0xffff) + (sum >>> 16);
  return (~sum) & 0xffff;
}

export interface EncodeFrameArgs {
  cmd: number;
  sessionId: number;
  replyId: number;
  payload?: Buffer | string;
}

export function encodeFrame({ cmd, sessionId, replyId, payload }: EncodeFrameArgs): Buffer {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf8") : (payload ?? Buffer.alloc(0));
  const length = ZK_HEADER_SIZE + data.length;
  if (length > MAX_FRAME_BYTES) throw new ProtocolError("پیلود پروتکل بیش از حد مجاز است.");
  const frame = Buffer.alloc(8 + length);
  frame.writeUInt16LE(PROTOCOL_TAG, 0);
  frame.writeUInt16LE(TCP_MAGIC, 2);
  frame.writeUInt32LE(length, 4);
  frame.writeUInt16LE(cmd & 0xffff, 8);
  frame.writeUInt16LE(sessionId & 0xffff, 12);
  frame.writeUInt16LE(replyId & 0xffff, 14);
  data.copy(frame, 16);
  frame.writeUInt16LE(protocolChecksum(frame.subarray(8)), 10);
  return frame;
}

export interface DecodedFrame {
  cmd: number;
  sessionId: number;
  replyId: number;
  payload: Buffer;
  consumed: number;
}
export class ProtocolError extends Error {}

/** Bounded incremental decoder: supports fragmented and coalesced TCP frames. */
export function tryDecodeFrame(buf: Buffer): DecodedFrame | null {
  if (buf.length < 4) return null;
  if (buf.readUInt16LE(0) !== PROTOCOL_TAG || buf.readUInt16LE(2) !== TCP_MAGIC) {
    throw new ProtocolError("بایت آغازین فریم پروتکل نامعتبر است.");
  }
  if (buf.length < 8) return null;
  const length = buf.readUInt32LE(4);
  if (length < ZK_HEADER_SIZE || length > MAX_FRAME_BYTES) {
    throw new ProtocolError("طول فریم پروتکل خارج از محدوده مجاز است.");
  }
  if (buf.length < 8 + length) return null;
  const body = buf.subarray(8, 8 + length);
  if (protocolChecksum(body) !== 0) {
    throw new ProtocolError("صحت فریم پروتکل (چک‌سام) تأیید نشد.");
  }
  return {
    cmd: body.readUInt16LE(0),
    sessionId: body.readUInt16LE(4),
    replyId: body.readUInt16LE(6),
    payload: Buffer.from(body.subarray(ZK_HEADER_SIZE)),
    consumed: 8 + length,
  };
}

/** pyzk make_commkey: reverse bits, add session, XOR ZKSO, swap words. */
export function makeCommKey(commKey: string, sessionId: number, ticks = 50): Buffer {
  if (!/^\d{1,10}$/.test(commKey) || Number(commKey) > 0xffffffff) {
    throw new Error("کلید ارتباط دستگاه نامعتبر است.");
  }
  const key = Number(commKey);
  let reversed = 0;
  for (let i = 0; i < 32; i++) reversed = ((reversed << 1) | ((key >>> i) & 1)) >>> 0;
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE((reversed + sessionId) >>> 0);
  for (let i = 0; i < 4; i++) bytes[i] ^= "ZKSO".charCodeAt(i);
  const swapped = Buffer.from([bytes[2], bytes[3], bytes[0], bytes[1]]);
  const tick = ticks & 0xff;
  return Buffer.from([swapped[0] ^ tick, swapped[1] ^ tick, tick, swapped[3] ^ tick]);
}

// ---------------- option read/response helpers ----------------

/** Build the payload for reading a device option (e.g. ~SerialNumber). */
export function optionsRequestPayload(key: string): Buffer {
  return Buffer.from(`~${key}\x00`, "utf8");
}

/**
 * Parse an options response payload ("~Key=Value" pairs separated by
 * NUL/TAB/newline) into a plain object. Unknown shapes return {} —
 * callers treat that as a protocol-stage failure, never as a match.
 */
export function parseOptionsResponse(payload: Buffer): Record<string, string> {
  const text = payload.toString("latin1");
  const out: Record<string, string> = {};
  const re = /~?([A-Za-z0-9_]+)=([^\x00\t\r\n]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out[m[1]] = m[2].trim();
    if (Object.keys(out).length > 64) break; // bounded
  }
  return out;
}

// ---------------- realtime event parsing ----------------

export interface ParsedLiveEvent {
  userId: string;
  deviceLocalMs: number;
  punch: number;
  verify: number;
}

/**
 * Parse ONE realtime verification event payload.
 *
 * Strict per-spec field order: USER ID, DEVICE TIMESTAMP, PUNCH STATE,
 * VERIFICATION METHOD — punch state and verification method are NEVER
 * interchanged. Anything that does not match exactly is rejected as an
 * unfamiliar format (fail-closed, never guessed). Leading TAB and the
 * optional TRANS prefix are tolerated.
 */
export function parseLiveEventPayload(payload: Buffer): ParsedLiveEvent[] {
  // PUSH/relay text records have a different field order from native TCP.
  if (!/^(?:TRANS)?\t?\d{1,9}\t/.test(payload.toString("utf8"))) return parseBinaryLiveEvent(payload);
  const text = payload.toString("utf8");
  const events: ParsedLiveEvent[] = [];
  for (const rawLine of text.split(/\r\n|\n/)) {
    let line = rawLine;
    if (line.startsWith("\t")) line = line.slice(1);
    if (line.startsWith("TRANS")) line = line.slice(5); // optional TRANS prefixes tolerated
    line = line.replace(/^\t+/, "");
    if (!line) continue;
    const fields = line.split("\t");
    if (fields.length < 4) continue; // unfamiliar → rejected
    const userId = fields[0]?.trim() ?? "";
    const ts = fields[1]?.trim() ?? "";
    const punch = Number.parseInt(fields[2]?.trim() ?? "", 10);
    const verify = Number.parseInt(fields[3]?.trim() ?? "", 10);
    const deviceLocalMs = parseDeviceLocalTimestamp(ts);
    if (!/^\d{1,9}$/.test(userId) || deviceLocalMs === null) continue;
    if (!Number.isInteger(punch) || punch < 0 || punch > 255) continue;
    if (!Number.isInteger(verify) || verify < 0 || verify > 65535) continue;
    events.push({ userId, deviceLocalMs, punch, verify });
    if (events.length >= 100) break; // bounded per frame
  }
  return events;
}

/** Native TCP attendance events: user id, verify method, punch, six-byte time.
 * Only known record sizes are accepted; no user/template downloads are needed.
 */
function parseBinaryLiveEvent(payload: Buffer): ParsedLiveEvent[] {
  const length = payload.length;
  const numericWidth = length === 10 || length === 14 ? 2 : length === 12 ? 4 : 0;
  const width = numericWidth || ([32, 36, 37, 52].includes(length) ? 24 : 0);
  if (!width) return [];
  const userId = numericWidth === 2 ? String(payload.readUInt16LE(0))
    : numericWidth === 4 ? String(payload.readUInt32LE(0))
    : payload.subarray(0, 24).toString("ascii").split("\0")[0].trim();
  if (!/^[1-9]\d{0,8}$/.test(userId)) return [];
  const verify = payload[width];
  const punch = payload[width + 1];
  const [year, month, day, hour, minute, second] = payload.subarray(width + 2, width + 8);
  const ms = Date.UTC(2000 + year, month - 1, day, hour, minute, second);
  const d = new Date(ms);
  if (d.getUTCFullYear() !== 2000 + year || d.getUTCMonth() !== month - 1 ||
      d.getUTCDate() !== day || d.getUTCHours() !== hour ||
      d.getUTCMinutes() !== minute || d.getUTCSeconds() !== second) return [];
  return [{ userId, deviceLocalMs: ms, punch, verify }];
}
