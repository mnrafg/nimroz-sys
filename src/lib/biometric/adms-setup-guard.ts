import "server-only";
import { execOk, shQuote, type SshSession } from "./adms-ssh";
import {
  ADMS_ACCOUNT,
  ADMS_DB_FILE,
  ADMS_ETC_DIR,
  ADMS_OPT_DIR,
  ADMS_RELEASES_DIR,
  ADMS_SERVICE_NAME,
  ADMS_VAR_DIR,
  type ListenerOccupancy,
} from "./adms-setup-contract";

// ============================================================
// Read-only namespace / port conflict guard for the ADMS setup
// wizard. Every command here is strictly OBSERVATIONAL — the guard
// never installs packages, never restarts services, never touches
// firewall rules, routes or foreign configuration. It only answers:
// "what is already there, and would the install collide with it?"
//
// OBSERVED FACTS vs POSSIBLE CAUSES: raw facts are returned as
// structured data; the findings[] strings are explicitly labelled
// possibilities, never presented as proven end-to-end results.
// ============================================================

export interface DirFacts {
  exists: boolean;
  owner: string | null;
  group: string | null;
}

export interface NamespaceFacts {
  serviceInstalled: boolean;
  serviceActive: boolean;
  accountExists: boolean;
  opt: DirFacts;
  etc: DirFacts;
  var: DirFacts;
  dbFileExists: boolean;
  releaseDirs: string[];
  /** symlink target of /opt/aogc-bicms-adms/current (basename), or null */
  currentRelease: string | null;
}

// ---------------- ss -tlnp parsing (pure, unit-testable) ----------------

export interface SsListenerRow {
  port: number;
  processName: string | null;
  pid: number | null;
}

export function parseSsListeners(output: string): SsListenerRow[] {
  const rows: SsListenerRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0] !== "LISTEN") continue;
    // local address:port column — handles 0.0.0.0:8081, [::]:8081, *:8081
    const local = parts[3] ?? "";
    const idx = local.lastIndexOf(":");
    if (idx < 0) continue;
    const port = Number(local.slice(idx + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const procMatch = /users:\(\("([^"]+)".*?pid=(\d+)/.exec(line);
    rows.push({
      port,
      processName: procMatch ? procMatch[1] : null,
      pid: procMatch ? Number(procMatch[2]) : null,
    });
  }
  return rows;
}

export function occupancyFor(rows: SsListenerRow[], port: number): ListenerOccupancy {
  const hits = rows.filter((r) => r.port === port);
  if (hits.length === 0) return { occupied: false, byWhom: null };
  const named = hits.find((r) => r.processName);
  const byWhom = named ? `${named.processName}${named.pid ? ` (pid ${named.pid})` : ""}` : "فرایند ناشناس";
  return { occupied: true, byWhom };
}

/** Probe the given ports via ONE bounded `ss -tlnp` call (read-only). */
export async function probePortMap(
  session: SshSession,
  ports: readonly number[]
): Promise<Map<number, ListenerOccupancy>> {
  const res = await execOk(session, "ss -tlnp 2>/dev/null || ss -tln", { timeoutMs: 8_000, maxBytes: 64 * 1024 });
  const rows = res.ok ? parseSsListeners(res.stdout) : [];
  const map = new Map<number, ListenerOccupancy>();
  for (const port of ports) map.set(port, occupancyFor(rows, port));
  return map;
}

// ---------------- namespace probes (all read-only) ----------------

async function probeDir(session: SshSession, path: string): Promise<DirFacts> {
  const res = await execOk(
    session,
    `if [ -d ${shQuote(path)} ]; then stat -c '%U:%G' ${shQuote(path)} 2>/dev/null; else echo __MISSING__; fi`,
    { timeoutMs: 6_000 }
  );
  const out = res.stdout.trim();
  if (!res.ok || out.includes("__MISSING__") || !out) {
    return { exists: false, owner: null, group: null };
  }
  const [owner, group] = out.split(":");
  return { exists: true, owner: owner || null, group: group || null };
}

export async function probeNamespace(session: SshSession): Promise<NamespaceFacts> {
  const [installedRes, activeRes, accountRes, opt, etc, dir, dbRes, releasesRes, currentRes] = await Promise.all([
    execOk(session, `systemctl list-unit-files ${ADMS_SERVICE_NAME} --no-legend 2>/dev/null`, { timeoutMs: 6_000 }),
    execOk(session, `systemctl is-active ${ADMS_SERVICE_NAME} 2>/dev/null`, { timeoutMs: 6_000 }),
    execOk(session, `id -u ${shQuote(ADMS_ACCOUNT)} 2>/dev/null`, { timeoutMs: 6_000 }),
    probeDir(session, ADMS_OPT_DIR),
    probeDir(session, ADMS_ETC_DIR),
    probeDir(session, ADMS_VAR_DIR),
    execOk(session, `[ -f ${shQuote(ADMS_DB_FILE)} ] && echo yes || echo no`, { timeoutMs: 6_000 }),
    execOk(session, `ls -1 ${ADMS_RELEASES_DIR} 2>/dev/null | head -50`, { timeoutMs: 8_000 }),
    execOk(session, `readlink ${ADMS_OPT_DIR}/current 2>/dev/null`, { timeoutMs: 6_000 }),
  ]);

  const currentTarget = currentRes.ok ? currentRes.stdout.trim() : "";
  const currentBasename = currentTarget ? currentTarget.split("/").filter(Boolean).pop() ?? null : null;

  return {
    serviceInstalled: installedRes.ok && installedRes.stdout.includes(ADMS_SERVICE_NAME),
    serviceActive: activeRes.ok && activeRes.stdout.trim() === "active",
    accountExists: accountRes.ok && /^\d+\s*$/.test(accountRes.stdout.trim()),
    opt,
    etc,
    var: dir,
    dbFileExists: dbRes.ok && dbRes.stdout.trim() === "yes",
    releaseDirs: releasesRes.ok
      ? releasesRes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 50)
      : [],
    currentRelease: currentBasename,
  };
}

export interface UfwFacts {
  available: boolean;
  /** trimmed `ufw status` output (bounded) — null when unavailable */
  status: string | null;
}

/** Read-only `ufw status`. Never flushes/disables anything. */
export async function probeUfw(session: SshSession): Promise<UfwFacts> {
  const res = await execOk(session, `command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null || echo __NOUFW__`, {
    timeoutMs: 8_000,
    maxBytes: 16 * 1024,
  });
  const out = res.stdout.trim();
  if (!res.ok || out.includes("__NOUFW__") || !out) return { available: false, status: null };
  return { available: true, status: out.slice(0, 4000) };
}

// ---------------- device observations (passive, read-only) ----------------

export interface DeviceObservations {
  seenRequests: boolean;
  lastSeen: string | null;
}

const SQLITE_SERIAL_COLUMNS = ["serial", "device_sn", "sn"] as const;

/**
 * Passive lookup of the selected serial inside the service data dir.
 * Uses `sqlite3 -readonly` ONLY when available; when the tool or the
 * schema is not what we expect the probe silently reports "nothing
 * seen" instead of guessing. Never writes to the database.
 */
export async function probeDeviceObservations(
  session: SshSession,
  deviceSerial: string
): Promise<DeviceObservations> {
  const tool = await execOk(session, "command -v sqlite3 >/dev/null 2>&1 && echo yes || echo no", { timeoutMs: 5_000 });
  if (!tool.ok || tool.stdout.trim() !== "yes") {
    return { seenRequests: false, lastSeen: null };
  }
  const dbq = shQuote(ADMS_DB_FILE);
  const serialLit = deviceSerial.replace(/'/g, "''");

  const tablesRes = await execOk(
    session,
    `sqlite3 -readonly ${dbq} "SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%last_seen%';" 2>/dev/null | head -5`,
    { timeoutMs: 8_000 }
  );
  if (!tablesRes.ok || !tablesRes.stdout.trim()) {
    return { seenRequests: false, lastSeen: null };
  }
  for (const rawTable of tablesRes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    const table = rawTable.replace(/"/g, "");
    for (const col of SQLITE_SERIAL_COLUMNS) {
      const q = `sqlite3 -readonly ${dbq} "SELECT last_seen FROM \\"${table}\\" WHERE ${col}='${serialLit}' AND last_seen IS NOT NULL ORDER BY last_seen DESC LIMIT 1;" 2>/dev/null | head -1`;
      const res = await execOk(session, q, { timeoutMs: 8_000, maxBytes: 8 * 1024 });
      const value = res.ok ? res.stdout.trim() : "";
      if (value) {
        return { seenRequests: true, lastSeen: value.slice(0, 64) };
      }
    }
  }
  return { seenRequests: false, lastSeen: null };
}

// ---------------- conflict assessment ----------------

export interface GuardConflict {
  /** Dari message; always phrased as an OBSERVED blocking condition */
  message: string;
  kind: "port" | "namespace" | "ownership";
}

export interface GuardAssessment {
  ok: boolean;
  conflicts: GuardConflict[];
}

const FOREIGN_SERVICE_HINTS = ["nginx", "apache", "frappe", "erpnext", "caddy", "node", "python"];

/**
 * Decide whether the install may proceed on this host. Blocking rules:
 *   • a FOREIGN service already owns the ADMS listener ports
 *   • the ADMS tree exists but is owned by an unexpected account
 * The service itself owning its own ports (resume/upgrade) is fine.
 */
export function assessNamespace(
  namespace: NamespaceFacts,
  listenerMap: Map<number, ListenerOccupancy>,
  ports: { deviceListener: number; internalApi: number; httpsApi: number }
): GuardAssessment {
  const conflicts: GuardConflict[] = [];

  for (const [role, port] of [
    ["شنونده دستگاه (device listener)", ports.deviceListener],
    ["API داخلی (internal API)", ports.internalApi],
    ["API امن HTTPS", ports.httpsApi],
  ] as const) {
    const occ = listenerMap.get(port);
    if (!occ || !occ.occupied) continue;
    const byWhom = occ.byWhom ?? "فرایند ناشناس";
    const looksForeign = FOREIGN_SERVICE_HINTS.some((h) => byWhom.toLowerCase().includes(h)) ||
      !(byWhom.includes("bicms") || byWhom.includes("aogc"));
    // Our own service holding its own ports is NOT a conflict.
    if (looksForeign) {
      conflicts.push({
        kind: "port",
        message: `پورت ${port} (${role}) از قبل توسط فرایند دیگری اشغال شده است: ${byWhom}. نصب متوقف شد تا تنظیمات آن سرویس بررسی شود.`,
      });
    }
  }

  if (namespace.opt.exists && namespace.opt.owner && ![ADMS_ACCOUNT, "root"].includes(namespace.opt.owner)) {
    conflicts.push({
      kind: "ownership",
      message: `پوشه ${ADMS_OPT_DIR} از قبل موجود است اما متعلق به کاربر دیگری است (${namespace.opt.owner}).`,
    });
  }
  if (namespace.etc.exists && namespace.etc.owner && ![ADMS_ACCOUNT, "root"].includes(namespace.etc.owner)) {
    conflicts.push({
      kind: "ownership",
      message: `پوشه ${ADMS_ETC_DIR} از قبل موجود است اما متعلق به کاربر دیگری است (${namespace.etc.owner}).`,
    });
  }
  if (namespace.var.exists && namespace.var.owner && ![ADMS_ACCOUNT, "root"].includes(namespace.var.owner)) {
    conflicts.push({
      kind: "ownership",
      message: `پوشه ${ADMS_VAR_DIR} از قبل موجود است اما متعلق به کاربر دیگری است (${namespace.var.owner}).`,
    });
  }

  return { ok: conflicts.length === 0, conflicts };
}
