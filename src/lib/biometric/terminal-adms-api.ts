import "server-only";
import { request as httpsRequest } from "https";
import { request as httpRequest, type RequestOptions } from "http";
import { isIP } from "node:net";

// ============================================================
// Read-only ADMS API adapter + private HTTPS connection.
//
// The adapter uses ONLY three endpoints against the configured API:
//   GET /
//   GET /api/devices/{serial}/status
//   GET /api/attendance?device_sn=...&limit=200&offset=0&include_total=false
//
// It NEVER performs ERPNext synchronization, attendance deletion,
// device commands, template/photo requests or server administration.
//
// TLS verification is never disabled: when a pinned certificate is
// supplied it is used as the ONLY trust anchor (Node still validates
// hostname + validity); rejectUnauthorized=false is not used anywhere.
// ============================================================

export const ADMS_ATTENDANCE_LIMIT = 200;

export interface AdmsFetchOptions {
  url: string;
  bearerToken?: string | null;
  caPem?: string | null;
  timeoutMs?: number;
  maxBytes?: number;
}

export type AdmsFetchResult =
  | { ok: true; status: number; text: string }
  | { ok: false; stage: "URL" | "TLS" | "TIMEOUT" | "NETWORK" | "SIZE" | "STATUS"; message: string; httpStatus?: number };

function requestOnce(opts: AdmsFetchOptions, statusFloor = 200, statusCeil = 299): Promise<AdmsFetchResult> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(opts.url);
    } catch {
      return resolve({ ok: false, stage: "URL", message: "آدرس API نامعتبر است." });
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return resolve({ ok: false, stage: "URL", message: "فقط HTTP/HTTPS پشتیبانی می‌شود." });
    }
    const isHttps = url.protocol === "https:";
    const timeoutMs = opts.timeoutMs ?? 8000;
    const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;

    const reqOptions: RequestOptions = {
      method: "GET",
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      timeout: timeoutMs,
      headers: {
        Accept: "application/json, text/plain",
        ...(opts.bearerToken ? { Authorization: `Bearer ${opts.bearerToken}` } : {}),
      },
      ...(isHttps && opts.caPem
        ? {
          ca: opts.caPem,
          rejectUnauthorized: true,
          // TLS SNI accepts DNS names only. IP endpoints still have their
          // certificate's IP subject alternative name verified normally.
          ...(isIP(url.hostname) === 0 ? { servername: url.hostname } : {}),
        }
        : {}),
    };

    const doReq = isHttps ? httpsRequest : httpRequest;
    let settled = false;
    const done = (r: AdmsFetchResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };

    const req = doReq(reqOptions, (res) => {
      const status = res.statusCode ?? 0;
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          res.destroy();
          return done({ ok: false, stage: "SIZE", message: "پاسخ سرور ADMS بیش از حد مجاز است." });
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (status < statusFloor || status > statusCeil) {
          return done({
            ok: false,
            stage: "STATUS",
            httpStatus: status,
            message: `پاسخ سرور ADMS با کد وضعیت ${status} برگشت.`,
          });
        }
        done({ ok: true, status, text: Buffer.concat(chunks).toString("utf8") });
      });
      res.on("error", () => done({ ok: false, stage: "NETWORK", message: "خواندن پاسخ ADMS ناموفق بود." }));
    });

    req.on("timeout", () => {
      req.destroy();
      done({ ok: false, stage: "TIMEOUT", message: "زمان انتظار پاسخ ADMS پایان یافت." });
    });
    req.on("error", (err) => {
      const msg = String(err?.message ?? "");
      done({
        ok: false,
        stage: msg.includes("CERT") || msg.includes("TLS") ? "TLS" : "NETWORK",
        message: "اتصال به سرور ADMS ناموفق بود.",
      });
    });
    req.end();
  });
}

export interface AdmsHealthInfo {
  reachable: boolean;
  status?: number;
  server?: string | null;
  bodyPreview?: string | null;
  message: string;
}

/**
 * GET / health probe. A successful API health check does NOT prove the
 * terminal is online — it only proves the API answers.
 */
export async function admsApiHealth(opts: AdmsFetchOptions): Promise<AdmsHealthInfo> {
  const res = await requestOnce({ ...opts, timeoutMs: opts.timeoutMs ?? 6000 }, 200, 299);
  if (!res.ok) return { reachable: false, message: res.stage === "STATUS" && res.message.includes("404") ? "API سرور ADMS در این آدرس یافت نشد (404). پورت دستگاه‌شنونده 8081 است؛ آدرس API خصوصی را در تنظیمات بک‌اند بررسی کنید." : res.message };
  let server: string | null = null;
  try {
    const json = JSON.parse(res.text) as Record<string, unknown>;
    if (json && typeof json === "object") {
      server = typeof json.service === "string" ? json.service : typeof json.name === "string" ? json.name : null;
    }
  } catch {
    server = res.text.slice(0, 80);
  }
  return { reachable: true, status: res.status, server, bodyPreview: res.text.slice(0, 120), message: "سرور پاسخ داد." };
}

// ---------------- validated shapes ----------------

export interface AdmsDeviceStatus {
  serial: string;
  online: boolean;
  lastSeen: string | null;
  ip?: string | null;
}

function boundedJson(text: string, maxBytes: number): unknown | null {
  if (Buffer.byteLength(text, "utf8") > maxBytes) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * GET /api/devices/{serial}/status — the response must contain the
 * EXACT serial and an explicit online flag. Mismatched serials are a
 * validation failure, not a soft warning.
 */
export async function admsDeviceStatus(args: {
  apiUrl: string;
  serial: string;
  bearerToken?: string | null;
  caPem?: string | null;
  timeoutMs?: number;
}): Promise<{ ok: true; status: AdmsDeviceStatus } | { ok: false; message: string; httpStatus?: number }> {
  const base = args.apiUrl.replace(/\/+$/, "");
  const res = await requestOnce(
    { url: `${base}/api/devices/${encodeURIComponent(args.serial)}/status`, bearerToken: args.bearerToken, caPem: args.caPem, timeoutMs: args.timeoutMs ?? 8000 },
    200,
    299
  );
  if (!res.ok) return { ok: false, message: res.message, httpStatus: res.httpStatus };
  const json = boundedJson(res.text, 256 * 1024);
  if (!json || typeof json !== "object") return { ok: false, httpStatus: res.status, message: "ساختار وضعیت دستگاه نامعتبر است." };
  const rec = json as Record<string, unknown>;
  const inner = (typeof rec.device === "object" && rec.device !== null ? rec.device : rec) as Record<string, unknown>;
  const serial = inner.serial ?? inner.serial_number ?? inner.device_sn ?? inner.sn;
  if (typeof serial !== "string" || serial.toUpperCase() !== args.serial.toUpperCase()) {
    return { ok: false, httpStatus: res.status, message: "سریال پاسخ سرور با دستگاه مورد نظر مطابقت ندارد." };
  }
  const online =
    inner.online === true ||
    inner.is_online === true ||
    inner.status === "online" ||
    (inner.state === "online" as unknown) === true;
  const lastSeen = typeof inner.last_seen === "string" ? inner.last_seen : typeof inner.lastSeen === "string" ? inner.lastSeen : typeof inner.last_seen_at === "string" ? inner.last_seen_at : null;
  const ip = typeof inner.ip === "string" ? inner.ip : typeof inner.last_ip === "string" ? inner.last_ip : typeof inner.ip_address === "string" ? inner.ip_address : null;
  return {
    ok: true,
    status: { serial: args.serial, online: online === true, lastSeen, ip },
  };
}

export interface AdmsAttendanceRow {
  id: number; // immutable server row id
  deviceSn: string;
  userId: string; // numeric string
  timestamp: string; // device-local "YYYY-MM-DD HH:mm:ss"
  state: number | null; // punch state
  verify: number | null; // verification method
}

function parseRow(raw: unknown): AdmsAttendanceRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = Number(r.id ?? r.row_id ?? r.attendance_id);
  const sn = r.device_sn ?? r.deviceSn ?? r.serial ?? r.sn;
  const uid = r.user_id ?? r.uid ?? r.userid;
  const ts = r.timestamp ?? r.time ?? r.punch_time ?? r.device_time;
  const state = r.state ?? r.punch_state ?? r.status;
  const verify = r.verify ?? r.verify_mode ?? r.verification_mode ?? r.verification;
  if (!Number.isFinite(id) || typeof sn !== "string" || typeof ts !== "string") return null;
  const uidStr = String(uid);
  if (!/^\d{1,9}$/.test(uidStr)) return null;
  const stateN = state === null || state === undefined ? null : Number(state);
  const verifyN = verify === null || verify === undefined ? null : Number(verify);
  return {
    id,
    deviceSn: sn,
    userId: uidStr,
    timestamp: ts,
    state: stateN !== null && Number.isInteger(stateN) ? stateN : null,
    verify: verifyN !== null && Number.isInteger(verifyN) ? verifyN : null,
  };
}

/**
 * GET /api/attendance — compatible parameters preserved
 * (device_sn, limit=200, offset=0, include_total=false).
 * Rows belonging to another serial are filtered OUT and counted.
 */
export async function admsAttendance(args: {
  apiUrl: string;
  serial: string;
  bearerToken?: string | null;
  caPem?: string | null;
  offset?: number;
  timeoutMs?: number;
}): Promise<
  | { ok: true; rows: AdmsAttendanceRow[]; foreignRows: number; total: number | null }
  | { ok: false; message: string }
> {
  const base = args.apiUrl.replace(/\/+$/, "");
  const offset = Math.max(0, Math.min(1_000_000, args.offset ?? 0));
  const url = `${base}/api/attendance?device_sn=${encodeURIComponent(args.serial)}&limit=${ADMS_ATTENDANCE_LIMIT}&offset=${offset}&include_total=false`;
  const res = await requestOnce(
    { url, bearerToken: args.bearerToken, caPem: args.caPem, timeoutMs: args.timeoutMs ?? 10_000 },
    200,
    299
  );
  if (!res.ok) return { ok: false, message: res.message };
  const json = boundedJson(res.text, 2 * 1024 * 1024);
  if (json === null) return { ok: false, message: "ساختار فهرست حاضری نامعتبر است یا بیش از حد بزرگ است." };
  let list: unknown[];
  let total: number | null = null;
  if (Array.isArray(json)) list = json;
  else if (typeof json === "object" && json !== null) {
    const rec = json as Record<string, unknown>;
    const maybeList = rec.attendance ?? rec.rows ?? rec.data ?? rec.results;
    if (!Array.isArray(maybeList)) return { ok: false, message: "ساختار فهرست حاضری نامعتبر است." };
    list = maybeList;
    if (typeof rec.total === "number") total = rec.total;
  } else {
    return { ok: false, message: "ساختار فهرست حاضری نامعتبر است." };
  }
  if (list.length > 1000) return { ok: false, message: "پاسخ حاضری بیش از حد بزرگ است." };
  const rows: AdmsAttendanceRow[] = [];
  let foreignRows = 0;
  for (const raw of list) {
    const row = parseRow(raw);
    if (!row) continue; // invalid row shape — skipped
    if (row.deviceSn.toUpperCase() !== args.serial.toUpperCase()) {
      foreignRows += 1;
      continue;
    }
    rows.push(row);
    if (rows.length >= ADMS_ATTENDANCE_LIMIT) break;
  }
  return { ok: true, rows, foreignRows, total };
}
