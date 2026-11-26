// ============================================================
// Unit tests: read-only ADMS API adapter (terminal-adms-api.ts).
//
// The adapter speaks real http against URLs — for unit tests every
// case drives a LOCAL node:http server bound to 127.0.0.1 on an
// ephemeral port. No public host is ever contacted.
//
// The adapter's failure stages (SIZE / STATUS / NETWORK / ...) are not
// exported, so each stage is asserted through its distinct Dari
// failure message as returned by the public functions.
// ============================================================
import { mock, test, expect, describe } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

mock.module("server-only", () => ({}));

const api = await import("../src/lib/biometric/terminal-adms-api");
const { admsDeviceStatus, admsAttendance, admsApiHealth } = api;

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function startServer(handler: Handler): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    // Keep the test server closable and resilient to aborted clients.
    res.setHeader("connection", "close");
    res.on("error", () => {});
    req.on("error", () => {});
    handler(req, res);
  });
  server.on("clientError", (_err, socket) => {
    try {
      socket.end();
    } catch {
      /* ignore */
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${addr.port}` };
}

async function stopServer(server: Server): Promise<void> {
  (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Grab an ephemeral port, then release it to simulate a dead endpoint. */
async function getFreePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

const SERIAL = "CQJH214560083";

describe("admsDeviceStatus", () => {
  test("happy path: exact route, bearer header, parsed status", async () => {
    const seen = { url: "", auth: "" };
    const { server, url } = await startServer((req, res) => {
      seen.url = req.url ?? "";
      seen.auth = (req.headers.authorization as string) ?? "";
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          device: { serial: SERIAL, online: true, last_seen: "2025-01-01 10:00:00", ip: "192.168.1.201" },
        })
      );
    });
    try {
      // trailing slash in apiUrl must be normalized away
      const r = await admsDeviceStatus({ apiUrl: `${url}/`, serial: SERIAL, bearerToken: "tok-1", timeoutMs: 4000 });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.status.serial).toBe(SERIAL);
        expect(r.status.online).toBe(true);
        expect(r.status.lastSeen).toBe("2025-01-01 10:00:00");
        expect(r.status.ip).toBe("192.168.1.201");
      }
      expect(seen.url).toBe(`/api/devices/${SERIAL}/status`);
      expect(seen.auth).toBe("Bearer tok-1");
    } finally {
      await stopServer(server);
    }
  }, 15000);

  test("response carrying a foreign serial is a validation failure (ok:false)", async () => {
    const { server, url } = await startServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ serial: "OTHERSN9999", online: true }));
    });
    try {
      const r = await admsDeviceStatus({ apiUrl: url, serial: SERIAL, timeoutMs: 4000 });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.message).toBe("سریال پاسخ سرور با دستگاه مورد نظر مطابقت ندارد.");
      }
    } finally {
      await stopServer(server);
    }
  }, 15000);

  test("non-object JSON body is a validation failure", async () => {
    const { server, url } = await startServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end("123");
    });
    try {
      const r = await admsDeviceStatus({ apiUrl: url, serial: SERIAL, timeoutMs: 4000 });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.message).toBe("ساختار وضعیت دستگاه نامعتبر است.");
      }
    } finally {
      await stopServer(server);
    }
  }, 15000);

  test("oversized response (>2MB) fails with the size-limit message", async () => {
    const { server, url } = await startServer((_req, res) => {
      res.setHeader("content-type", "text/plain");
      res.write("A".repeat(1024 * 1024));
      res.write("A".repeat(1024 * 1024));
      res.write("A".repeat(128 * 1024)); // 2MB + 128KB > default maxBytes
      res.end();
    });
    try {
      const r = await admsDeviceStatus({ apiUrl: url, serial: SERIAL, timeoutMs: 8000 });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.message).toBe("پاسخ سرور ADMS بیش از حد مجاز است.");
      }
    } finally {
      await stopServer(server);
    }
  }, 15000);

  test("500 response fails with the status-code message", async () => {
    const { server, url } = await startServer((_req, res) => {
      res.statusCode = 500;
      res.end("boom");
    });
    try {
      const r = await admsDeviceStatus({ apiUrl: url, serial: SERIAL, timeoutMs: 4000 });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.message).toBe("پاسخ سرور ADMS با کد وضعیت 500 برگشت.");
      }
    } finally {
      await stopServer(server);
    }
  }, 15000);

  test("connection refused fails with the network message", async () => {
    const port = await getFreePort();
    const r = await admsDeviceStatus({
      apiUrl: `http://127.0.0.1:${port}`,
      serial: SERIAL,
      timeoutMs: 2000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toBe("اتصال به سرور ADMS ناموفق بود.");
    }
  }, 15000);

  test("non-http(s) URL scheme rejected before any network activity", async () => {
    const r = await admsDeviceStatus({ apiUrl: "ftp://127.0.0.1/x", serial: SERIAL, timeoutMs: 1000 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toBe("فقط HTTP/HTTPS پشتیبانی می‌شود.");
    }
  });

  test("unparseable URL rejected", async () => {
    const r = await admsDeviceStatus({ apiUrl: "not-a-url", serial: SERIAL, timeoutMs: 1000 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toBe("آدرس API نامعتبر است.");
    }
  });
});

describe("admsAttendance", () => {
  test("rows parsed, foreign + invalid rows filtered, canonical query params sent", async () => {
    const seenUrls: string[] = [];
    const { server, url } = await startServer((req, res) => {
      seenUrls.push(req.url ?? "");
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          total: 42,
          attendance: [
            // 1) valid row for the requested serial
            { id: 7, device_sn: SERIAL, user_id: "12", timestamp: "2025-01-01 10:00:00", state: 0, verify: 1 },
            // 2) VALID shape but foreign serial → counted + excluded
            { id: 8, device_sn: "OTHERSN9999", user_id: "34", timestamp: "2025-01-01 10:01:00", state: 1, verify: 15 },
            // 3) non-numeric user id → invalid shape, skipped (not foreign)
            { id: 9, device_sn: SERIAL, user_id: "not-num", timestamp: "2025-01-01 10:02:00" },
            // 4) alternate key aliases (time/punch_state/verify_mode)
            { id: 10, device_sn: SERIAL, user_id: "56", time: "2025-01-01 10:03:00", punch_state: 1, verify_mode: 15 },
            // 5) shapeless junk → skipped
            { nope: true },
            // 6) missing state/verify → null fields
            { id: 11, device_sn: SERIAL, user_id: "77", timestamp: "2025-01-01 10:05:00" },
          ],
        })
      );
    });
    try {
      const r = await admsAttendance({ apiUrl: url, serial: SERIAL, timeoutMs: 4000 });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.rows.length).toBe(3);
        expect(r.foreignRows).toBe(1);
        expect(r.total).toBe(42);
        expect(r.rows[0]).toEqual({
          id: 7,
          deviceSn: SERIAL,
          userId: "12",
          timestamp: "2025-01-01 10:00:00",
          state: 0,
          verify: 1,
        });
        expect(r.rows[1]).toEqual({
          id: 10,
          deviceSn: SERIAL,
          userId: "56",
          timestamp: "2025-01-01 10:03:00",
          state: 1,
          verify: 15,
        });
        expect(r.rows[2]).toEqual({
          id: 11,
          deviceSn: SERIAL,
          userId: "77",
          timestamp: "2025-01-01 10:05:00",
          state: null,
          verify: null,
        });
      }

      // server-side seen query: canonical ADMS-compatible parameters
      const q = new URL(seenUrls[0] ?? "/", "http://127.0.0.1").searchParams;
      expect(q.get("device_sn")).toBe(SERIAL);
      expect(q.get("limit")).toBe("200");
      expect(q.get("offset")).toBe("0");
      expect(q.get("include_total")).toBe("false");
      expect((seenUrls[0] ?? "").split("?")[0]).toBe("/api/attendance");

      // second call: offset forwarded and clamped/encoded as given
      await admsAttendance({ apiUrl: url, serial: SERIAL, offset: 50, timeoutMs: 4000 });
      const q2 = new URL(seenUrls[1] ?? "/", "http://127.0.0.1").searchParams;
      expect(q2.get("offset")).toBe("50");
      expect(q2.get("device_sn")).toBe(SERIAL);
    } finally {
      await stopServer(server);
    }
  }, 15000);

  test("invalid list JSON fails with a validation message", async () => {
    const { server, url } = await startServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ attendance: "not-an-array" }));
    });
    try {
      const r = await admsAttendance({ apiUrl: url, serial: SERIAL, timeoutMs: 4000 });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.message).toBe("ساختار فهرست حاضری نامعتبر است.");
      }
    } finally {
      await stopServer(server);
    }
  }, 15000);

  test("plain top-level array responses are accepted", async () => {
    const { server, url } = await startServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([{ id: 1, device_sn: SERIAL, user_id: "5", timestamp: "2025-01-01 08:00:00", state: 0, verify: 1 }]));
    });
    try {
      const r = await admsAttendance({ apiUrl: url, serial: SERIAL, timeoutMs: 4000 });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.rows.length).toBe(1);
        expect(r.total).toBeNull();
        expect(r.rows[0].userId).toBe("5");
      }
    } finally {
      await stopServer(server);
    }
  }, 15000);
});

describe("admsApiHealth", () => {
  test("JSON body → reachable with parsed service name", async () => {
    const { server, url } = await startServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ service: "bicms-adms", ok: true }));
    });
    try {
      const h = await admsApiHealth({ url, timeoutMs: 4000 });
      expect(h.reachable).toBe(true);
      expect(h.status).toBe(200);
      expect(h.server).toBe("bicms-adms");
      expect(h.bodyPreview).toContain("bicms-adms");
      expect(h.message).toBe("سرور پاسخ داد.");
    } finally {
      await stopServer(server);
    }
  }, 15000);

  test("404 is not a healthy ADMS API", async () => {
    const { server, url } = await startServer((_req, res) => {
      res.statusCode = 404;
      res.end("plain-text-404");
    });
    try {
      const h = await admsApiHealth({ url, timeoutMs: 4000 });
      expect(h.reachable).toBe(false);
      expect(h.message).toContain("404");
      expect(h.server).toBeUndefined();
    } finally {
      await stopServer(server);
    }
  }, 15000);
});

test("ADMS 404 preserves HTTP response evidence without claiming device online", async () => {
  const {server,url}=await startServer((_req,res)=>{
    res.statusCode=404;res.setHeader("content-type","application/json");res.end(JSON.stringify({detail:"Not Found"}));
  });
  try {
    const result=await admsDeviceStatus({apiUrl:url,serial:SERIAL});
    expect(result.ok).toBe(false);
    if(!result.ok)expect(result.httpStatus).toBe(404);
  } finally {await stopServer(server);}
});

test("BICMS ADMS v2 device fields are compatible", async()=>{
 const {server,url}=await startServer((_req,res)=>{
  res.setHeader("content-type","application/json");
  res.end(JSON.stringify({serial_number:SERIAL,name:"Border terminal",last_seen:"2026-11-22T10:00:00.000Z",ip_address:"192.168.1.50",is_online:true,status:"online"}));
 });
 try{
  const result=await admsDeviceStatus({apiUrl:url,serial:SERIAL});
  expect(result.ok).toBe(true);
  if(result.ok)expect(result.status).toEqual({serial:SERIAL,online:true,lastSeen:"2026-11-22T10:00:00.000Z",ip:"192.168.1.50"});
 }finally{await stopServer(server);}
});

test("BICMS ADMS v2 flat attendance preserves punch and verify_mode", async()=>{
 const {server,url}=await startServer((_req,res)=>{
  res.setHeader("content-type","application/json");
  res.end(JSON.stringify([{id:42,device_sn:SERIAL,user_id:"12345",timestamp:"2026-11-22 14:30:00",status:0,verify_mode:1,created_at:"2026-11-22T10:00:00.000Z"}]));
 });
 try{
  const result=await admsAttendance({apiUrl:url,serial:SERIAL});
  expect(result.ok).toBe(true);
  if(result.ok){expect(result.rows[0].userId).toBe("12345");expect(result.rows[0].state).toBe(0);expect(result.rows[0].verify).toBe(1);}
 }finally{await stopServer(server);}
});
