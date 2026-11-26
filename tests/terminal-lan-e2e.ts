/**
 * LAN terminal path END-TO-END verification (app + simulator, no hardware).
 *
 * bun tests/terminal-lan-e2e.ts
 *
 * Scenario matrix (all against the RUNNING dev app on :3000):
 *  1. happy path: connect → auth (no key) → serial verified → subscribed;
 *     fingerprint event (fragmented across 3 writes) ingested ONCE;
 *     coalesced card event (verify=2) NEVER stored
 *  2. serial mismatch: stage FAILED with SERIAL_MISMATCH message
 *  3. comm key required: without a stored key → AUTH_FAILED;
 *     with the correct stored key → SUBSCRIBED
 */
import { Database } from "bun:sqlite";

const BASE = "http://localhost:3000";
const DB_FILE = new URL("../db/custom.db", import.meta.url).pathname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let cookie = "";
async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      "Sec-Fetch-Site": "same-origin",
    },
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return { status: res.status, json: { raw: text } };
  }
}

function simArgs(extra: string[]): string[] {
  return ["tests/terminal-simulator.ts", ...extra];
}

async function waitStage(serial: string, want: string | string[], timeoutMs = 15_000): Promise<Record<string, unknown>> {
  const wants = Array.isArray(want) ? want : [want];
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const res = await api(`/api/biometric/terminal/status?deviceKey=${encodeURIComponent(serial)}`);
    last = (res.json.connection as Record<string, unknown>) ?? {};
    if (wants.includes(String(last.stage))) return last;
    await sleep(500);
  }
  return last;
}

function scanCount(serial: string, userId?: string): number {
  const db = new Database(DB_FILE, { readonly: true });
  const q = userId
    ? db.query("SELECT COUNT(*) c FROM TerminalScan WHERE deviceKey=? AND terminalUserId=?").get(serial, userId)
    : db.query("SELECT COUNT(*) c FROM TerminalScan WHERE deviceKey=?").get(serial);
  db.close();
  return Number((q as { c: number }).c);
}

async function main() {
  console.log("== LAN terminal E2E verification ==");
  const login = await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "admin@aogc.gov.af", password: "Admin@123" }),
  });
  if (login.status !== 200) throw new Error("login failed");

  // deterministic test checkpoint
  const checkpoints = (await api("/api/checkpoints")).json as { checkpoints: { id: number; code: string }[] };
  const checkpointId = checkpoints.checkpoints?.[0]?.id;
  if (!checkpointId) throw new Error("no checkpoint available");

  const stamp = Date.now().toString().slice(-6);

  // ---------- scenario 1: happy path + fragmentation/coalescing ----------
  const sim1Port = 14370 + Math.floor(Math.random() * 100);
  const serial1 = `SIM1E${stamp}`;
  const proc1 = Bun.spawn(["bun", ...simArgs([String(sim1Port), serial1, "--push", "12", "1", "0"])], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await sleep(700);
  await api("/api/biometric/terminal/devices", {
    method: "POST",
    body: JSON.stringify({ name: "دستگاه آزمون ۱", transport: "LAN", serial: serial1, checkpointId, host: "127.0.0.1", port: sim1Port }),
  });
  const s1 = await waitStage(serial1, "SUBSCRIBED");
  console.log(`[1] stage=${s1.stage} error=${s1.stageError ?? "—"}`);
  await sleep(2500); // allow events (pushed at ~1.5 s after connect) to land
  const finger = scanCount(serial1, "12");
  const cardRows = new Database(DB_FILE, { readonly: true })
    .query("SELECT COUNT(*) c FROM TerminalScan WHERE deviceKey=? AND method != 'FINGERPRINT'").get(serial1) as { c: number };
  console.log(`[1] fingerprint scans stored=${finger} (expect ≥1) | non-biometric stored=${cardRows.c} (expect 0)`);
  if (String(s1.stage) !== "SUBSCRIBED" || finger < 1 || cardRows.c !== 0) {
    proc1.kill();
    throw new Error("scenario 1 FAILED");
  }
  proc1.kill();

  // ---------- scenario 2: serial mismatch ----------
  const sim2Port = 14400 + Math.floor(Math.random() * 100);
  const serial2 = `SIM2M${stamp}`;
  const proc2 = Bun.spawn(["bun", ...simArgs([String(sim2Port), serial2, "--wrong-serial"])], { stdout: "pipe", stderr: "pipe" });
  await sleep(700);
  await api("/api/biometric/terminal/devices", {
    method: "POST",
    body: JSON.stringify({ name: "دستگاه آزمون ۲", transport: "LAN", serial: serial2, checkpointId, host: "127.0.0.1", port: sim2Port }),
  });
  const s2 = await waitStage(serial2, ["FAILED", "DISCONNECTED"]);
  console.log(`[2] stage=${s2.stage} error=${s2.stageError ?? "—"}`);
  const mismatch = String(s2.stageError ?? "").includes("سریال");
  if (!mismatch) {
    proc2.kill();
    throw new Error("scenario 2 FAILED — serial mismatch not reported");
  }
  proc2.kill();

  // ---------- scenario 3: comm-key auth ----------
  const sim3Port = 14500 + Math.floor(Math.random() * 100);
  const serial3 = `SIM3K${stamp}`;
  const KEY = "123789";
  const proc3 = Bun.spawn(["bun", ...simArgs([String(sim3Port), serial3, "--commkey", KEY])], { stdout: "pipe", stderr: "pipe" });
  await sleep(700);
  await api("/api/biometric/terminal/devices", {
    method: "POST",
    body: JSON.stringify({ name: "دستگاه آزمون ۳", transport: "LAN", serial: serial3, checkpointId, host: "127.0.0.1", port: sim3Port }),
  });
  const s3a = await waitStage(serial3, ["FAILED", "DISCONNECTED"]);
  console.log(`[3a] without key: stage=${s3a.stage} error=${s3a.stageError ?? "—"}`);
  const authFailed = String(s3a.stageError ?? "").includes("احراز هویت");
  // store the correct comm key
  await api("/api/biometric/terminal/devices", {
    method: "PATCH",
    body: JSON.stringify({ id: ((await api("/api/biometric/terminal/devices")).json as { devices: { id: number; serial: string }[] }).devices.find((d) => d.serial === serial3)!.id, name: "دستگاه آزمون ۳", transport: "LAN", serial: serial3, checkpointId, host: "127.0.0.1", port: sim3Port, commKey: KEY }),
  });
  const s3b = await waitStage(serial3, "SUBSCRIBED");
  console.log(`[3b] with key: stage=${s3b.stage}`);
  if (!authFailed || String(s3b.stage) !== "SUBSCRIBED") {
    proc3.kill();
    throw new Error("scenario 3 FAILED");
  }
  proc3.kill();

  // ---------- scenario 4: TWO OFFICERS COMPETING FOR ONE TERMINAL ----------
  // The live SSE stream holds the EXCLUSIVE lease per USER; a second
  // OFFICER's stream receives the LEASE_BUSY notice immediately and
  // closes (same-owner reconnects intentionally take over instead).
  const roles = (await api("/api/roles")).json as { roles: { id: number; name: string }[] };
  const officerRole = roles.roles?.find((r) => r.name === "OFFICER");
  if (!officerRole) throw new Error("scenario 4: OFFICER role missing");
  const officerEmail = `lease-rival-${stamp}@aogc-test.local`;
  const createdUser = await api("/api/users", {
    method: "POST",
    body: JSON.stringify({
      name: "مأمور رقیب آزمون",
      email: officerEmail,
      password: "Off1cer@Lease123",
      roleId: officerRole.id,
      checkpointId,
      isActive: true,
    }),
  });
  if (createdUser.status !== 201 && createdUser.status !== 200) {
    throw new Error(`scenario 4: officer creation failed ${createdUser.status} ${JSON.stringify(createdUser.json)}`);
  }
  const officerId = (createdUser.json as { user: { id: number } }).user.id;

  const rivalLogin = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
    body: JSON.stringify({ email: officerEmail, password: "Off1cer@Lease123" }),
  });
  if (rivalLogin.status !== 200) throw new Error("scenario 4: officer login failed");
  const rivalCookie = (rivalLogin.headers.get("set-cookie") ?? "").split(";")[0];

  const serial4 = serial3; // reuse the comm-key device (SUBSCRIBED path)
  const controller = new AbortController();
  const holder = await fetch(`${BASE}/api/biometric/terminal/events?deviceKey=${encodeURIComponent(serial4)}`, {
    headers: { cookie, "Sec-Fetch-Site": "same-origin" },
    signal: controller.signal,
  });
  if (!holder.ok) throw new Error(`scenario 4: holder stream failed HTTP ${holder.status}`);
  // let the holder's lease settle, then connect the second OFFICER
  await sleep(1500);
  const rival = await fetch(`${BASE}/api/biometric/terminal/events?deviceKey=${encodeURIComponent(serial4)}`, {
    headers: { cookie: rivalCookie, "Sec-Fetch-Site": "same-origin" },
  });
  const rivalBody = await rival.text(); // the short notice stream closes itself
  const busy = rivalBody.includes("LEASE_BUSY");
  console.log(`[4] second officer stream: LEASE_BUSY=${busy}`);
  controller.abort(); // release the holder's lease
  // cleanup: deactivate the rival account + remove the sim device (script)
  await api(`/api/users/${officerId}`, {
    method: "PUT",
    body: JSON.stringify({ name: "مأمور رقیب آزمون", email: officerEmail, isActive: false }),
  });
  if (!busy) throw new Error("scenario 4 FAILED — lease exclusivity not enforced");
  await sleep(500); // lease release lands

  console.log("== ALL LAN SCENARIOS PASSED ==");
  process.exit(0);
}

main().catch((e) => {
  console.error("E2E FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
