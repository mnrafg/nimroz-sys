// ============================================================
// Unit tests: terminal protocol codec (frame/checksum/comm-key/
// options/live-event parsing) + terminal rules (method mapping,
// user-id validation, freshness, timestamps, constants).
//
// NOTE on the `server-only` stub: the modules under test call
// `import "server-only"`, which throws outside React Server
// Components. Bun does NOT hoist mock.module above static imports,
// so the modules are imported DYNAMICALLY after the mock
// registration (verified empirically against bun 1.3.14).
// ============================================================
import { mock, test, expect, describe } from "bun:test";

mock.module("server-only", () => ({}));

const protocol = await import("../src/lib/biometric/terminal-protocol");
const rules = await import("../src/lib/biometric/terminal-rules");

const {
  protocolChecksum,
  encodeFrame,
  tryDecodeFrame,
  ProtocolError,
  makeCommKey,
  parseOptionsResponse,
  parseLiveEventPayload,
  PROTOCOL_TAG,
  MAX_FRAME_BYTES,
  ZK_HEADER_SIZE,
} = protocol;

function catchOf(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}

// Device wall-clock reference used across several suites.
const T = "2025-01-01 10:00:00";
const T_MS = Date.UTC(2025, 0, 1, 10, 0, 0); // 1735725600000
const T5_MS = Date.UTC(2025, 0, 1, 10, 0, 5); // 1735725605000

// Independent wire fixture: pyzk's initial CMD_CONNECT packet, not
// produced by this codec. This catches the previous simulator/codec agreement
// on an incorrect protocol.
const CONNECT_WIRE = Buffer.from("5050827d08000000e80317fc00000000", "hex");

describe("ZKTeco standalone wire compatibility", () => {
  test("command numbers match the standalone SDK", () => {
    expect([protocol.CMD_CONNECT, protocol.CMD_EXIT, protocol.CMD_AUTH,
      protocol.CMD_OPTIONS_RRQ, protocol.CMD_REG_EVENT]).toEqual([1000, 1001, 1102, 11, 500]);
  });
  test("connect packet matches independent pyzk bytes", () => {
    expect(encodeFrame({ cmd: 1000, sessionId: 0, replyId: 0 })).toEqual(CONNECT_WIRE);
    expect(tryDecodeFrame(CONNECT_WIRE)).toEqual({cmd:1000, sessionId:0, replyId:0, payload:Buffer.alloc(0), consumed:16});
  });
  test("fragmentation at EVERY byte boundary", () => {
    for (let i=0; i<CONNECT_WIRE.length; i++) expect(tryDecodeFrame(CONNECT_WIRE.subarray(0,i))).toBeNull();
  });
  test("coalesced response and binary event preserve frame boundaries", () => {
    const next = encodeFrame({cmd:500, sessionId:77, replyId:3, payload:Buffer.from([0,255,3])});
    const data=Buffer.concat([CONNECT_WIRE,next]);
    const first=tryDecodeFrame(data)!;
    expect(first.consumed).toBe(16);
    expect(tryDecodeFrame(data.subarray(first.consumed))?.payload).toEqual(Buffer.from([0,255,3]));
  });
  test("reject corrupt payload, wrong magic, and oversized/short body", () => {
    const bad=Buffer.from(CONNECT_WIRE);bad[8]^=1;
    expect(()=>tryDecodeFrame(bad)).toThrow(ProtocolError);
    const magic=Buffer.from(CONNECT_WIRE);magic[2]=0;
    expect(()=>tryDecodeFrame(magic)).toThrow(ProtocolError);
    for(const length of [7,MAX_FRAME_BYTES+1]) {
      const frame=Buffer.from(CONNECT_WIRE);frame.writeUInt32LE(length,4);
      expect(()=>tryDecodeFrame(frame)).toThrow(ProtocolError);
    }
    expect(()=>encodeFrame({cmd:1000,sessionId:0,replyId:0,payload:Buffer.alloc(MAX_FRAME_BYTES)})).toThrow();
  });
  test("known comm-key vectors from pyzk bit reversal and ZKSO scrambling", () => {
    expect(makeCommKey("0",0).toString("hex")).toBe("617d3279");
    expect(makeCommKey("1",0).toString("hex")).toBe("61fd3279");
    expect(makeCommKey("123456",0xabcd).toString("hex")).toBe("297f3252");
    for (const key of ["abc","-5","","12abc","4294967296"]) expect(()=>makeCommKey(key,0)).toThrow();
  });
});

describe("native TCP attendance events", () => {
  test("physical terminal 36-byte fingerprint event (async session 1)", () => {
    const wire=Buffer.from("5050827d2c000000f4013f4c0100000031323334350000000000000000000000000000000000000001001a0b160b013500000000","hex");
    const decoded=tryDecodeFrame(wire)!;
    expect(decoded.cmd).toBe(500);expect(decoded.sessionId).toBe(1);
    expect(parseLiveEventPayload(decoded.payload)).toEqual([{userId:"12345",verify:1,punch:0,deviceLocalMs:Date.UTC(2026,10,22,11,1,53)}]);
  });

  test("binary verify method precedes punch (unlike PUSH text)", () => {
    const payload=Buffer.from("0c0001001901010a0000","hex");
    expect(parseLiveEventPayload(payload)).toEqual([{userId:"12",deviceLocalMs:T_MS,punch:0,verify:1}]);
  });
  test("24-character id variant and tab-valued day decode as binary", () => {
    const payload=Buffer.alloc(32);payload.write("123");payload[24]=15;payload[25]=1;
    Buffer.from([25,1,9,10,0,0]).copy(payload,26);
    expect(parseLiveEventPayload(payload)).toEqual([{userId:"123",deviceLocalMs:Date.UTC(2025,0,9,10),punch:1,verify:15}]);
    payload[27]=13;expect(parseLiveEventPayload(payload)).toEqual([]);
  });
  test("unknown binary formats never fabricate scans", () => {
    expect(parseLiveEventPayload(Buffer.alloc(15))).toEqual([]);
    expect(parseLiveEventPayload(Buffer.alloc(10))).toEqual([]);
  });
});

describe("parseOptionsResponse", () => {
  test("single ~SerialNumber option", () => {
    expect(parseOptionsResponse(Buffer.from("~SerialNumber=CQJH214560083\x00", "latin1"))).toEqual({
      SerialNumber: "CQJH214560083",
    });
  });

  test("multiple keys separated by tabs (and newlines)", () => {
    const payload = "~SerialNumber=ABC123\t~DeviceName=Gate A\t~IPAddress=192.168.1.201\n~FaceFunOn=1\x00";
    expect(parseOptionsResponse(Buffer.from(payload, "latin1"))).toEqual({
      SerialNumber: "ABC123",
      DeviceName: "Gate A",
      IPAddress: "192.168.1.201",
      FaceFunOn: "1",
    });
  });

  test("values are trimmed; non-matching payloads return {}", () => {
    expect(parseOptionsResponse(Buffer.from("~DeviceName= Gate A \x00", "latin1"))).toEqual({
      DeviceName: "Gate A",
    });
    expect(parseOptionsResponse(Buffer.alloc(0))).toEqual({});
    expect(parseOptionsResponse(Buffer.from("no tilde pairs here"))).toEqual({});
  });
});

describe("parseLiveEventPayload (strict field order)", () => {
  test("leading tab form parses to one event with exact fields", () => {
    expect(parseLiveEventPayload(Buffer.from(`\t12\t${T}\t0\t1`, "utf8"))).toEqual([
      { userId: "12", deviceLocalMs: T_MS, punch: 0, verify: 1 },
    ]);
  });

  test("TRANS prefix tolerated and leading tab optional", () => {
    const expected = [{ userId: "12", deviceLocalMs: T_MS, punch: 0, verify: 1 }];
    expect(parseLiveEventPayload(Buffer.from(`TRANS\t12\t${T}\t0\t1`, "utf8"))).toEqual(expected);
    expect(parseLiveEventPayload(Buffer.from(`12\t${T}\t0\t1`, "utf8"))).toEqual(expected);
  });

  test("punch and verify are NEVER interchanged (strict order)", () => {
    expect(parseLiveEventPayload(Buffer.from(`12\t${T}\t1\t0`, "utf8"))).toEqual([
      { userId: "12", deviceLocalMs: T_MS, punch: 1, verify: 0 },
    ]);
    // face verification method 15 stays in the verify slot
    expect(parseLiveEventPayload(Buffer.from(`34\t${T}\t0\t15`, "utf8"))).toEqual([
      { userId: "34", deviceLocalMs: T_MS, punch: 0, verify: 15 },
    ]);
  });

  test("more than 4 fields tolerated as extra data", () => {
    expect(parseLiveEventPayload(Buffer.from(`12\t${T}\t0\t1\textra\tmore`, "utf8"))).toEqual([
      { userId: "12", deviceLocalMs: T_MS, punch: 0, verify: 1 },
    ]);
  });

  test("wrong field count rejected (empty array)", () => {
    expect(parseLiveEventPayload(Buffer.from(`12\t${T}\t0`, "utf8"))).toEqual([]);
    expect(parseLiveEventPayload(Buffer.from(`12\t${T}`, "utf8"))).toEqual([]);
    expect(parseLiveEventPayload(Buffer.from(`12`, "utf8"))).toEqual([]);
  });

  test("unknown / non-numeric fields rejected", () => {
    expect(parseLiveEventPayload(Buffer.from(`12\t${T}\tX\t1`, "utf8"))).toEqual([]); // punch
    expect(parseLiveEventPayload(Buffer.from(`12\t${T}\t0\tabc`, "utf8"))).toEqual([]); // verify
    expect(parseLiveEventPayload(Buffer.from(`ab\t${T}\t0\t1`, "utf8"))).toEqual([]); // user id
    expect(parseLiveEventPayload(Buffer.from(`12\t2025-01-01\t0\t1`, "utf8"))).toEqual([]); // bad ts
    expect(parseLiveEventPayload(Buffer.from(`12\tnot-a-time\t0\t1`, "utf8"))).toEqual([]); // bad ts
    expect(parseLiveEventPayload(Buffer.from(`12\t${T}\t300\t1`, "utf8"))).toEqual([]); // punch > 255
    expect(parseLiveEventPayload(Buffer.from(`12\t${T}\t0\t70000`, "utf8"))).toEqual([]); // verify > 65535
  });

  test("multi-line payloads (CRLF and LF) produce multiple events; empty lines skipped", () => {
    const payload = `\t12\t${T}\t0\t1\r\n\r\n\t34\t2025-01-01 10:00:05\t1\t15\n`;
    expect(parseLiveEventPayload(Buffer.from(payload, "utf8"))).toEqual([
      { userId: "12", deviceLocalMs: T_MS, punch: 0, verify: 1 },
      { userId: "34", deviceLocalMs: T5_MS, punch: 1, verify: 15 },
    ]);
  });

  test("empty payload → no events", () => {
    expect(parseLiveEventPayload(Buffer.alloc(0))).toEqual([]);
  });
});

describe("terminal-rules: terminalMethodForMode", () => {
  test("reference mapping", () => {
    expect(rules.terminalMethodForMode(1)).toBe("FINGERPRINT");
    for (const m of [15, 16, 17, 18, 19, 20]) expect(rules.terminalMethodForMode(m)).toBe("FACE");
    for (const m of [25, 26, 27, 28, 29]) expect(rules.terminalMethodForMode(m)).toBe("PALM");
    expect(rules.terminalMethodForMode(2)).toBe("CARD");
    expect(rules.terminalMethodForMode(4)).toBe("CARD");
    expect(rules.terminalMethodForMode(0)).toBe("PASSWORD");
    expect(rules.terminalMethodForMode(3)).toBe("PASSWORD");
    for (const m of [999, 5, 14, 21, 24, 30, 65535]) {
      expect(rules.terminalMethodForMode(m)).toBe("UNKNOWN");
    }
  });

  test("non-integer / out-of-range modes → UNKNOWN", () => {
    for (const m of [-1, 1.5, 65536, Number.NaN]) {
      expect(rules.terminalMethodForMode(m)).toBe("UNKNOWN");
    }
  });

  test("isBiometricMethod accepts exactly the three biometric methods", () => {
    expect(rules.isBiometricMethod("FINGERPRINT")).toBe(true);
    expect(rules.isBiometricMethod("FACE")).toBe(true);
    expect(rules.isBiometricMethod("PALM")).toBe(true);
    expect(rules.isBiometricMethod("CARD")).toBe(false);
    expect(rules.isBiometricMethod("PASSWORD")).toBe(false);
    expect(rules.isBiometricMethod("UNKNOWN")).toBe(false);
  });
});

describe("terminal-rules: isValidTerminalUserId", () => {
  test("positive numeric strings up to nine digits", () => {
    for (const ok of ["1", "12", "123456789"]) {
      expect(rules.isValidTerminalUserId(ok)).toBe(true);
    }
  });

  test("rejects everything else", () => {
    for (const bad of ["1234567890", "0", "012", "-1", "12a", "", " 1", "1 ", 12, null, undefined]) {
      expect(rules.isValidTerminalUserId(bad)).toBe(false);
    }
  });
});

describe("terminal-rules: classifyScanEligibility + freshness", () => {
  // Fixed server clock so the boundary assertions are deterministic.
  const NOW = new Date(Date.UTC(2025, 0, 1, 10, 0, 0));
  const at = (sec: number) => new Date(NOW.getTime() + sec * 1000);

  test("biometric + fresh → ok with method", () => {
    expect(rules.classifyScanEligibility({ verifyMode: 1, deviceTimeUtc: at(-30) }, NOW)).toEqual({
      ok: true,
      method: "FINGERPRINT",
    });
    expect(rules.classifyScanEligibility({ verifyMode: 20, deviceTimeUtc: at(-10) }, NOW)).toEqual({
      ok: true,
      method: "FACE",
    });
    expect(rules.classifyScanEligibility({ verifyMode: 25, deviceTimeUtc: at(0) }, NOW)).toEqual({
      ok: true,
      method: "PALM",
    });
  });

  test("card / password / unknown modes → NON_BIOMETRIC", () => {
    for (const mode of [2, 4, 0, 3, 999]) {
      expect(rules.classifyScanEligibility({ verifyMode: mode, deviceTimeUtc: at(-5) }, NOW)).toEqual({
        ok: false,
        reason: "NON_BIOMETRIC",
      });
    }
  });

  test("stale and too-far-in-the-future scans → STALE", () => {
    // 91s old → stale
    expect(rules.classifyScanEligibility({ verifyMode: 1, deviceTimeUtc: at(-91) }, NOW)).toEqual({
      ok: false,
      reason: "STALE",
    });
    // 11s in the future → stale
    expect(rules.classifyScanEligibility({ verifyMode: 1, deviceTimeUtc: at(11) }, NOW)).toEqual({
      ok: false,
      reason: "STALE",
    });
  });

  test("boundary windows are inclusive (90s old ok, 10s future ok, 9s future ok)", () => {
    expect(rules.classifyScanEligibility({ verifyMode: 1, deviceTimeUtc: at(-90) }, NOW)).toEqual({
      ok: true,
      method: "FINGERPRINT",
    });
    expect(rules.classifyScanEligibility({ verifyMode: 1, deviceTimeUtc: at(10) }, NOW)).toEqual({
      ok: true,
      method: "FINGERPRINT",
    });
    expect(rules.classifyScanEligibility({ verifyMode: 1, deviceTimeUtc: at(9) }, NOW)).toEqual({
      ok: true,
      method: "FINGERPRINT",
    });
  });

  test("isFreshDeviceTime matches the same windows", () => {
    expect(rules.isFreshDeviceTime(at(-90), NOW)).toBe(true);
    expect(rules.isFreshDeviceTime(at(-91), NOW)).toBe(false);
    expect(rules.isFreshDeviceTime(at(-89), NOW)).toBe(true);
    expect(rules.isFreshDeviceTime(at(10), NOW)).toBe(true);
    expect(rules.isFreshDeviceTime(at(11), NOW)).toBe(false);
    expect(rules.isFreshDeviceTime(at(0), NOW)).toBe(true);
  });
});

describe("terminal-rules: scanEventKey", () => {
  test("deterministic dedup key with documented format", () => {
    const key = rules.scanEventKey("CQJH214560083", "12", 0, 1, T_MS);
    expect(key).toBe(`CQJH214560083:12:0:1:${T_MS}`);
    expect(rules.scanEventKey("CQJH214560083", "12", 0, 1, T_MS)).toBe(key);
  });

  test("any input change yields a different key", () => {
    const key = rules.scanEventKey("CQJH214560083", "12", 0, 1, T_MS);
    expect(rules.scanEventKey("OTHERSN9999", "12", 0, 1, T_MS)).not.toBe(key);
    expect(rules.scanEventKey("CQJH214560083", "13", 0, 1, T_MS)).not.toBe(key);
    expect(rules.scanEventKey("CQJH214560083", "12", 1, 1, T_MS)).not.toBe(key);
    expect(rules.scanEventKey("CQJH214560083", "12", 0, 15, T_MS)).not.toBe(key);
    expect(rules.scanEventKey("CQJH214560083", "12", 0, 1, T_MS + 1000)).not.toBe(key);
  });
});

describe("terminal-rules: device timestamps", () => {
  test("parseDeviceLocalTimestamp valid forms", () => {
    expect(rules.parseDeviceLocalTimestamp("2025-01-01 10:00:00")).toBe(T_MS);
    expect(rules.parseDeviceLocalTimestamp("2025-01-01T10:00:00")).toBe(T_MS);
    expect(rules.parseDeviceLocalTimestamp("  2025-01-01 10:00:00  ")).toBe(T_MS);
  });

  test("parseDeviceLocalTimestamp invalid forms → null", () => {
    for (const bad of [
      "2025-01-01",
      "2025-1-1 10:00:00",
      "01/01/2025 10:00:00",
      "2025-01-01 10:00:00Z",
      "2025-01-01 10:00",
      "",
      "not-a-date",
    ]) {
      expect(rules.parseDeviceLocalTimestamp(bad)).toBeNull();
    }
  });

  test("deviceLocalToUtc / utcToDeviceLocal round trip with Kabul offset 270", () => {
    const localMs = Date.UTC(2025, 0, 1, 10, 0, 0); // device wall clock 10:00
    const utc = rules.deviceLocalToUtc(localMs, 270);
    // UTC+04:30 → 10:00 local is 05:30Z
    expect(utc.getTime()).toBe(localMs - 270 * 60_000);
    expect(utc.toISOString()).toBe("2025-01-01T05:30:00.000Z");
    const back = rules.utcToDeviceLocal(utc, 270);
    expect(back.getTime()).toBe(localMs);
  });
});

describe("terminal-rules: freshness constants", () => {
  test("documented windows", () => {
    expect(rules.SCAN_MAX_AGE_SEC).toBe(90);
    expect(rules.SCAN_MAX_FUTURE_SEC).toBe(10);
    expect(rules.ENROLLMENT_TTL_SEC).toBe(120);
    expect(rules.LEASE_TTL_SEC).toBe(25);
    expect(rules.DEFAULT_TZ_OFFSET_MINUTES).toBe(270);
  });
});
