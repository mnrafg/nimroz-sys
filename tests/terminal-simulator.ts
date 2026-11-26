/**
 * ZKTeco terminal SIMULATOR (local TCP) — verification fixture ONLY.
 *
 * Speaks the same pyzk-compatible framing as src/lib/biometric/terminal-protocol.ts,
 * so the LAN manager can be exercised end-to-end without hardware:
 *   connect (+ optional comm-key auth) → ~SerialNumber read → REG_EVENT
 *   subscribe → live verification events (with ACK) → heartbeat reads.
 *
 * Modes (argv):
 *   bun tests/terminal-simulator.ts <port> <serial> [commKey] [wrongSerial]
 *
 * Push a verification event via TCP by running:
 *   bun tests/terminal-simulator.ts <port> <serial> --push <userId> <verify> <punch>
 * (the simulator keeps running; events are injected over its own loop)
 */
import net from "net";

const CMD_CONNECT = 1000;
const CMD_AUTH = 1102;
const CMD_EXIT = 1001;
const CMD_OPTIONS_RRQ = 11;
const CMD_REG_EVENT = 500;
const CMD_ACK_OK = 2000;
const CMD_ACK_ERROR = 2001;
const CMD_ACK_DATA = 2002;
const CMD_ACK_UNAUTH = 2005;

function checksum(buf: Buffer): number {
  let sum = 0;
  let i = 0;
  const odd = buf.length % 2 === 1;
  const n = odd ? buf.length - 1 : buf.length;
  while (i < n) {
    sum += buf[i] + (buf[i + 1] << 8);
    i += 2;
  }
  if (odd) sum += buf[n];
  sum = (sum & 0xffff) + (sum >>> 16);
  const folded = (sum & 0xffff) + (sum >>> 16);
  return (~folded & 0xffff) >>> 0;
}

function encodeFrame(cmd: number, sessionId: number, replyId: number, payload: Buffer | string = Buffer.alloc(0)): Buffer {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const body = Buffer.alloc(8 + data.length);
  body.writeUInt16LE(cmd, 0);
  body.writeUInt16LE(sessionId, 4);
  body.writeUInt16LE(replyId, 6);
  data.copy(body, 8);
  body.writeUInt16LE(checksum(body), 2);
  const frame = Buffer.alloc(8 + body.length);
  frame.writeUInt16LE(0x5050, 0);
  frame.writeUInt16LE(32130, 2);
  frame.writeUInt32LE(body.length, 4);
  body.copy(frame, 8);
  return frame;
}

function makeCommKey(commKey: string, sessionId: number, ticks = 50): Buffer {
  let reversed = 0;
  const key=Number(commKey);
  for(let i=0;i<32;i++) reversed=((reversed<<1)|((key>>>i)&1))>>>0;
  const bytes=Buffer.alloc(4);bytes.writeUInt32LE((reversed+sessionId)>>>0);
  for(let i=0;i<4;i++)bytes[i]^="ZKSO".charCodeAt(i);
  return Buffer.from([bytes[2]^ticks,bytes[3]^ticks,ticks,bytes[1]^ticks]);
}

function localTimestamp(): string {
  // Kabul local wall clock as the device would report it
  const now = new Date(Date.now() + 270 * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())} ${p(now.getUTCHours())}:${p(now.getUTCMinutes())}:${p(now.getUTCSeconds())}`;
}

interface Args {
  port: number;
  serial: string;
  commKey?: string;
  wrongSerial?: boolean;
  push?: { userId: string; verify: number; punch: number };
}

const args: Args = (() => {
  const [, , port, serial, ...rest] = process.argv;
  const a: Args = { port: Number(port), serial };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--commkey") a.commKey = rest[i + 1];
    if (rest[i] === "--wrong-serial") a.wrongSerial = true;
    if (rest[i] === "--push") {
      a.push = { userId: rest[i + 1], verify: Number(rest[i + 2]), punch: Number(rest[i + 3]) };
    }
  }
  return a;
})();

const reportedSerial = args.wrongSerial ? `${args.serial}X` : args.serial;
let eventReplyId = 5000;
let authenticated = false;
const clients = new Set<net.Socket>();

function sendEvent(sock: net.Socket, userId: string, verify: number, punch: number, sessionId: number) {
  // classic realtime event payload: \t<uid>\t<ts>\t<punch>\t<verify>
  const payload = `\t${userId}\t${localTimestamp()}\t${punch}\t${verify}`;
  // fragmentation test: split the frame into three TCP writes
  const frame = encodeFrame(CMD_REG_EVENT, sessionId, (eventReplyId += 1) & 0xffff, payload);
  sock.write(frame.subarray(0, 4));
  setTimeout(() => sock.write(frame.subarray(4, 10)), 5);
  setTimeout(() => sock.write(frame.subarray(10)), 10);
  // coalescing test: a second (card-mode) event glued into ONE write
  const cardFrame = encodeFrame(CMD_REG_EVENT, sessionId, (eventReplyId += 1) & 0xffff, `\t${userId}\t${localTimestamp()}\t0\t2`);
  setTimeout(() => sock.write(Buffer.concat([cardFrame])), 40);
}

const server = net.createServer((sock) => {
  clients.add(sock);
  let sessionId = 0;
  let replyCounter = 0;
  let buffer = Buffer.alloc(0);
  let awaitingKey = !!args.commKey;

  sock.on("data", (chunk) => {
    // bun-types types the net chunk as string | Buffer — normalize first
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    buffer = Buffer.concat([buffer, buf]);
    for (;;) {
      if (buffer.length < 8) return;
      const len = buffer.readUInt32LE(4);
      if (buffer.length < 8 + len) return;
      const msg = buffer.subarray(8, 8 + len);
      buffer = buffer.subarray(8 + len);
      const cmd = msg.readUInt16LE(0);
      const payload = msg.subarray(8);
      const replyId = msg.readUInt16LE(6);

      if (cmd === CMD_CONNECT || cmd === CMD_AUTH) {
        if (awaitingKey) {
          // phase 1: device asks for its communication key (session 0)
          if (cmd === CMD_AUTH && payload.length === 4) {
            const expected = makeCommKey(args.commKey!, sessionId);
            if (payload.equals(expected)) {
              awaitingKey = false;
              // Authentication preserves the negotiated session.
              sock.write(encodeFrame(CMD_ACK_OK, sessionId, replyId));
            } else {
              sock.write(encodeFrame(CMD_ACK_ERROR, sessionId, replyId));
            }
          } else {
            sessionId = 4321;
            sock.write(encodeFrame(CMD_ACK_UNAUTH, sessionId, replyId));
          }
        } else {
          sessionId = 4321 + ++replyCounter;
          sock.write(encodeFrame(CMD_ACK_OK, sessionId, replyId));
        }
        continue;
      }
      if (cmd === CMD_OPTIONS_RRQ) {
        sock.write(encodeFrame(CMD_ACK_DATA, sessionId, replyId, `~SerialNumber=${reportedSerial}\x00`));
        continue;
      }
      if (cmd === CMD_REG_EVENT) {
        sock.write(encodeFrame(CMD_ACK_OK, sessionId, replyId));
        continue;
      }
      if (cmd === CMD_EXIT) {
        sock.write(encodeFrame(CMD_ACK_OK, sessionId, replyId));
        sock.end();
        continue;
      }
      sock.write(encodeFrame(CMD_ACK_OK, sessionId, replyId));
    }
  });

  // UNAUTH flow handled inline in the data handler
  sock.on("close", () => clients.delete(sock));
  sock.on("error", () => clients.delete(sock));

  if (args.push) {
    setTimeout(() => sendEvent(sock, args.push!.userId, args.push!.verify, args.push!.punch, sessionId), 1500);
  }
});

server.listen(args.port, "127.0.0.1", () => {
  console.log(`[simulator] listening 127.0.0.1:${args.port} serial=${reportedSerial} commKeyConfigured=${!!args.commKey} wrongSerial=${!!args.wrongSerial}`);
});
