import "server-only";
import { db } from "@/lib/db";
import {
  ADMS_IDLE_STOP_MS,
  ADMS_POLL_MS,
  DEFAULT_TZ_OFFSET_MINUTES,
  SCAN_MAX_AGE_SEC,
  SCAN_MAX_FUTURE_SEC,
  deviceLocalToUtc,
  parseDeviceLocalTimestamp,
  isValidTerminalUserId,
} from "./terminal-rules";
import { ingestTerminalScan } from "./terminal-ingestion";
import {
  admsAttendance,
  admsDeviceStatus,
} from "./terminal-adms-api";
import { resolveAdmsSettings, readConnectionProfile, tokenTransportAllowed } from "./terminal-adms-server";

// ============================================================
// Remote ADMS event feed.
//
// Reproduces the reference feed behavior:
//  • polls ≈ once per second while the device is in use
//  • stops after the idle window without consumers
//  • the FIRST response establishes a baseline — existing rows never
//    open an import form on startup and are never replayed
//  • subsequent eligible rows delivered in chronological order
//  • immutable server row ids tracked; duplicates and previously seen
//    edited rows rejected; foreign serials rejected
//  • terminal must be online; non-biometric methods rejected
//  • stale records and offline batches rejected
//  • freshness: max age 90 s, max future tolerance 10 s, device-local
//    timestamp interpreted with the configured offset (Kabul +270)
//  • changing the configured ADMS source resets the baseline (never
//    replays history as live identification)
// ============================================================

interface FeedState {
  serial: string;
  apiUrlKey: string; // ADMS source identity (baseline resets on change)
  createdAt: number; // activity anchor for idle-stop
  lastPollAt: number;
  lastActivityAt: number;
  baselineEstablished: boolean;
  seenRowIds: Set<number>;
  maxSeenRowId: number;
  timer: NodeJS.Timeout | null;
  lastError: string | null;
}

const feeds = new Map<string, FeedState>();

function feedKey(serial: string): string {
  return serial.toUpperCase();
}

function stopTimer(state: FeedState) {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

/** Reset feed state (new baseline) — used when the ADMS source changes. */
export function resetAdmsFeed(serial?: string): void {
  if (serial) {
    const state = feeds.get(feedKey(serial));
    if (state) stopTimer(state);
    feeds.delete(feedKey(serial));
    return;
  }
  for (const [, state] of feeds) stopTimer(state);
  feeds.clear();
}

async function pollOnce(state: FeedState): Promise<void> {
  state.lastPollAt = Date.now();
  const resolved = await resolveAdmsSettings();
  if (!resolved.apiUrl || !resolved.settings.readEnabled) {
    state.lastError = "تنظیمات سرور ADMS کامل نیست.";
    return;
  }
  if (`${resolved.apiUrl}|${resolved.settings.readEnabled}` !== state.apiUrlKey) {
    // ADMS source changed → new baseline, never replay history
    state.apiUrlKey = `${resolved.apiUrl}|${resolved.settings.readEnabled}`;
    state.baselineEstablished = false;
    state.seenRowIds.clear();
    state.maxSeenRowId = 0;
  }
  const profile = readConnectionProfile(resolved.apiUrl);
  if (!tokenTransportAllowed(resolved.apiUrl) && resolved.apiToken) {
    state.lastError = "ارسال توکن روی HTTP ساده مجاز نیست؛ HTTPS یا تونل محلی لازم است.";
    return;
  }

  // terminal must be online before any delivery
  const status = await admsDeviceStatus({
    apiUrl: resolved.apiUrl,
    serial: state.serial,
    bearerToken: resolved.apiToken,
    caPem: profile.caPem,
    timeoutMs: 6000,
  });
  if (!status.ok || !status.status.online) {
    state.lastError = status.ok ? "دستگاه در سرور ADMS آفلاین است." : status.message;
    return;
  }
  // device-facing evidence → device lastSeenAt
  await db.terminalDevice.updateMany({ where: { serial: state.serial }, data: { lastSeenAt: new Date() } });

  const page = await admsAttendance({
    apiUrl: resolved.apiUrl,
    serial: state.serial,
    bearerToken: resolved.apiToken,
    caPem: profile.caPem,
    timeoutMs: 8000,
  });
  if (!page.ok) {
    state.lastError = page.message;
    return;
  }

  const device = await db.terminalDevice.findUnique({ where: { serial: state.serial } });
  const offsetMinutes = device?.timezoneOffsetMinutes ?? DEFAULT_TZ_OFFSET_MINUTES;

  // chronological order by immutable server row id
  const rows = [...page.rows].sort((a, b) => a.id - b.id);
  if (!state.baselineEstablished) {
    for (const r of rows) {
      state.seenRowIds.add(r.id);
      if (r.id > state.maxSeenRowId) state.maxSeenRowId = r.id;
    }
    state.baselineEstablished = true;
    state.lastActivityAt = Date.now();
    state.lastError = null;
    return; // baseline only — never deliver historical rows
  }

  const now = Date.now();
  let delivered = 0;
  for (const row of rows) {
    if (row.id <= state.maxSeenRowId || state.seenRowIds.has(row.id)) continue; // duplicate / edited row
    state.seenRowIds.add(row.id);
    if (row.id > state.maxSeenRowId) state.maxSeenRowId = row.id;
    // trim the seen-set so it cannot grow unbounded
    if (state.seenRowIds.size > 5000) {
      const cutoff = state.maxSeenRowId - 4000;
      for (const id of [...state.seenRowIds]) if (id < cutoff) state.seenRowIds.delete(id);
    }
    if (!isValidTerminalUserId(row.userId)) continue;
    const localMs = parseDeviceLocalTimestamp(row.timestamp);
    if (localMs === null) continue; // invalid timestamp — rejected
    const deviceTimeUtc = deviceLocalToUtc(localMs, offsetMinutes);
    const ageSec = (now - deviceTimeUtc.getTime()) / 1000;
    if (ageSec > SCAN_MAX_AGE_SEC || ageSec < -SCAN_MAX_FUTURE_SEC) continue; // stale
    if (row.verify === null) continue; // missing verification method — rejected
    const ingested = await ingestTerminalScan({
      serial: state.serial,
      terminalUserId: row.userId,
      punch: row.state ?? 0,
      verify: row.verify,
      deviceLocalMs: localMs,
      timezoneOffsetMinutes: offsetMinutes,
    });
    if (ingested.ok && !ingested.duplicate) delivered += 1;
  }
  state.lastActivityAt = delivered > 0 ? Date.now() : state.lastActivityAt;
}

function startPolling(state: FeedState) {
  if (state.timer) return;
  state.timer = setInterval(() => {
    void pollOnce(state)
      .catch((e) => {
        state.lastError = "نظرسنجی سرور ADMS ناموفق بود.";
        console.error("[adms-feed] poll error", e);
      })
      .finally(() => {
        // stop after the idle window without activity
        if (Date.now() - Math.max(state.lastActivityAt, state.createdAt) > ADMS_IDLE_STOP_MS) {
          stopTimer(state);
          feeds.delete(feedKey(state.serial));
        }
      });
  }, ADMS_POLL_MS);
  void pollOnce(state).catch(() => {
    // first poll errors are surfaced via lastError on subsequent runs
  });
}

/** Ensure the feed for a device is running while it is "in use". */
export function ensureAdmsFeedRunning(serialInput: string): void {
  const serial = feedKey(serialInput);
  let state = feeds.get(serial);
  if (!state) {
    state = {
      serial,
      apiUrlKey: "",
      createdAt: Date.now(),
      lastPollAt: 0,
      lastActivityAt: Date.now(),
      baselineEstablished: false,
      seenRowIds: new Set(),
      maxSeenRowId: 0,
      timer: null,
      lastError: null,
    };
    feeds.set(serial, state);
  }
  state.lastActivityAt = Date.now(); // consumer activity keeps it alive
  startPolling(state);
}

/** Feed status for diagnostics (never exposes raw payloads). */
export function admsFeedStatus(serialInput: string): { running: boolean; baseline: boolean; lastError: string | null; lastPollAt: number | null } {
  const state = feeds.get(feedKey(serialInput));
  if (!state) return { running: false, baseline: false, lastError: null, lastPollAt: null };
  return {
    running: state.timer !== null,
    baseline: state.baselineEstablished,
    lastError: state.lastError,
    lastPollAt: state.lastPollAt || null,
  };
}
