/**
 * DB-backed integration tests for the terminal biometric flows.
 *
 * Runs against an ISOLATED copy of the dev database (VACUUM INTO a
 * temp file — the running application and the real dev data are never
 * touched). Covers the conflict matrix the spec requires:
 *
 *   • existing-mapping restoration (proposedTerminalUserId)
 *   • enrollment mapping conflicts (user-id taken / importer mapped elsewhere)
 *   • wrong-device / wrong-user scan pinning (a scan for another
 *     terminal user NEVER completes an enrollment)
 *   • pre-enrollment (old) scans are never accepted
 *   • non-owner completion is refused; owner-bound 120 s TTL expiry
 *   • a completed scan is reusable NEVER (single-use consumption)
 *   • two officers competing: simultaneous PENDING enrollments on the
 *     same device+user conflict for different owners
 *   • officer port restrictions (device and importer outside the
 *     officer's checkpoint are inaccessible)
 *   • replay-safe ingestion dedup + card/password rejection
 *
 * Run:  bun test tests/terminal-flows.test.ts
 */
import { beforeAll, afterAll, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const SOURCE_DB = join(import.meta.dir, "..", "db", "custom.db");
let tmpDir: string;
let dbFile: string;

// --- ISOLATION: resolved at MODULE EVALUATION time, before the dynamic
// @/lib/db import below instantiates the Prisma client (bun test imports
// every test file BEFORE running hooks — a beforeAll env change would be
// too late and the fixtures would land in the real dev database).
tmpDir = mkdtempSync(join(tmpdir(), "aogc-terminal-test-"));
dbFile = join(tmpDir, "test.db");
{
  const snapshot = new Database(SOURCE_DB, { readonly: true });
  snapshot.exec(`VACUUM INTO '${dbFile}'`);
  snapshot.close();
}
process.env.DATABASE_URL = `file:${dbFile}`;

// ---- imports AFTER env setup (bun hoists imports, so the db client is
// created lazily on first query — the URL above is in place by then) ----
const { db } = await import("@/lib/db");
const { startEnrollment, completeEnrollment, proposedTerminalUserId, expireStaleEnrollments, cancelEnrollment } = await import(
  "@/lib/biometric/terminal-enrollment"
);
const { ingestTerminalScan, consumeTerminalScan, resolveTerminalIdentity } = await import(
  "@/lib/biometric/terminal-ingestion"
);
const { latestEnrollmentScan } = await import("@/lib/biometric/terminal-enrollment");
const { FriendlyApiError } = await import("@/lib/api");
import type { SessionUser } from "@/lib/auth";

const STAMP = `${Date.now()}`.slice(-8);
const SERIAL = `TESTD${STAMP}`;
const ADMIN_EMAIL = `flow-admin-${STAMP}@test.local`;
const OFFICER_A_EMAIL = `flow-offa-${STAMP}@test.local`;
const OFFICER_B_EMAIL = `flow-offb-${STAMP}@test.local`;

let admin: SessionUser;
let officerA: SessionUser; // owns checkpoint A (the device's port)
let officerB: SessionUser; // different checkpoint B — no access
let deviceCheckpointId = 0;
let otherCheckpointId = 0;
let importerA1 = 0;
let importerA2 = 0;

let punchSeq = 0;
async function freshScan(args: {
  userId: string;
  method?: number;
  ageSec?: number;
  deviceKey?: string;
}): Promise<{ scanId: string; cursor: number }> {
  const age = args.ageSec ?? 0;
  const deviceLocalMs = Date.now() - age * 1000 + 270 * 60_000; // device-local Kabul wall clock
  const res = await ingestTerminalScan({
    serial: args.deviceKey ?? SERIAL,
    terminalUserId: args.userId,
    punch: punchSeq++ % 3, // distinct punch state keeps every fixture eventKey unique
    verify: args.method ?? 1,
    deviceLocalMs,
    timezoneOffsetMinutes: 270,
  });
  if (!res.ok) throw new Error(`fixture scan failed: ${res.message}`);
  return { scanId: res.scanId, cursor: res.cursor };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function purgeFixtures() {
  if (!dbFile) return;
  const src = new Database(dbFile);
  src.exec("PRAGMA foreign_keys=OFF");
  src.exec(`DELETE FROM TerminalScan WHERE deviceKey LIKE '${SERIAL}%'`);
  src.exec(`DELETE FROM TerminalLease WHERE deviceKey LIKE '${SERIAL}%'`);
  src.exec(`DELETE FROM TerminalEnrollment WHERE deviceKey LIKE '${SERIAL}%'`);
  src.exec(`DELETE FROM TerminalIdentity WHERE deviceKey LIKE '${SERIAL}%'`);
  src.exec(`DELETE FROM TerminalDevice WHERE serial LIKE '${SERIAL}%'`);
  src.exec(`DELETE FROM AuditLog WHERE recordType='TerminalIdentity' AND recordId NOT IN (SELECT id FROM TerminalIdentity) AND newValues LIKE '%${STAMP}%'`);
  src.exec(`DELETE FROM Importer WHERE importerCode LIKE '%${STAMP}%'`);
  src.exec(`DELETE FROM User WHERE email IN ('${ADMIN_EMAIL}','${OFFICER_A_EMAIL}','${OFFICER_B_EMAIL}')`);
  src.exec(`DELETE FROM BorderCheckpoint WHERE code LIKE '%${STAMP}%'`);
  src.exec("PRAGMA foreign_keys=ON");
  src.close();
}

async function findRoleId(name: string): Promise<number> {
  const role = await db.role.findUnique({ where: { name }, select: { id: true } });
  if (!role) throw new Error(`role ${name} missing in test db copy`);
  return role.id;
}

beforeAll(async () => {
  await purgeFixtures();

  const adminRoleId = await findRoleId("ADMIN");
  const officerRoleId = await findRoleId("OFFICER");

  const cpA = await db.borderCheckpoint.create({
    data: { name: `آزمون پورت الف ${STAMP}`, code: `TC1${STAMP}`, province: "نیمروز", status: "ACTIVE" },
  });
  const cpB = await db.borderCheckpoint.create({
    data: { name: `آزمون پورت ب ${STAMP}`, code: `TC2${STAMP}`, province: "نیمروز", status: "ACTIVE" },
  });
  deviceCheckpointId = cpA.id;
  otherCheckpointId = cpB.id;

  const uAdmin = await db.user.create({
    data: { email: ADMIN_EMAIL, name: "مدیر آزمون", passwordHash: "x", roleId: adminRoleId, isActive: true },
  });
  const uOffA = await db.user.create({
    data: { email: OFFICER_A_EMAIL, name: "مأمور الف", passwordHash: "x", roleId: officerRoleId, isActive: true, checkpointId: cpA.id },
  });
  const uOffB = await db.user.create({
    data: { email: OFFICER_B_EMAIL, name: "مأمور ب", passwordHash: "x", roleId: officerRoleId, isActive: true, checkpointId: cpB.id },
  });
  admin = { id: uAdmin.id, email: ADMIN_EMAIL, name: uAdmin.name, role: "ADMIN", checkpointId: null, checkpointName: null } as SessionUser;
  officerA = { id: uOffA.id, email: OFFICER_A_EMAIL, name: uOffA.name, role: "OFFICER", checkpointId: cpA.id, checkpointName: cpA.name } as SessionUser;
  officerB = { id: uOffB.id, email: OFFICER_B_EMAIL, name: uOffB.name, role: "OFFICER", checkpointId: cpB.id, checkpointName: cpB.name } as SessionUser;

  const iA1 = await db.importer.create({
    data: {
      importerCode: `IMP-T${STAMP}-1`,
      name: "واردکننده آزمون الف",
      importerType: "BORDER_WORKER",
      status: "ACTIVE",
      membershipStatus: "ACTIVE",
      registeredCheckpoint: { connect: { id: cpA.id } },
    },
  });
  const iA2 = await db.importer.create({
    data: {
      importerCode: `IMP-T${STAMP}-2`,
      name: "واردکننده آزمون ب",
      importerType: "BORDER_WORKER",
      status: "ACTIVE",
      membershipStatus: "ACTIVE",
      registeredCheckpoint: { connect: { id: cpA.id } },
    },
  });
  importerA1 = iA1.id;
  importerA2 = iA2.id;

  await db.terminalDevice.create({
    data: {
      serial: SERIAL,
      name: "دستگاه آزمون جریان",
      transport: "LAN",
      host: "127.0.0.1",
      port: 14370,
      checkpointId: cpA.id,
      isEnabled: true,
      createdById: uAdmin.id,
    },
  });
});

afterAll(async () => {
  try {
    await purgeFixtures();
  } finally {
    await db.$disconnect();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // temp dir cleanup is best-effort
    }
  }
});

// ============================================================
// 1. mapping restoration + conflicts
// ============================================================

test("proposedTerminalUserId falls back to importer id when no mapping exists", async () => {
  const proposed = await proposedTerminalUserId(SERIAL, importerA1);
  expect(proposed).toBe(String(importerA1));
});

test("enrollment completion creates the mapping; proposal then restores it", async () => {
  const scan = await freshScan({ userId: "11" });
  const enrollment = await startEnrollment(admin, { importerId: importerA1, deviceKey: SERIAL, terminalUserId: "11" });
  const done = await completeEnrollment(admin, enrollment.enrollmentId, scan.scanId);
  expect(done.ok).toBe(true);
  if (done.ok) {
    expect(done.identity).toMatchObject({ deviceKey: SERIAL, terminalUserId: "11", importerId: importerA1 });
    expect(["FINGERPRINT", "FACE", "PALM"]).toContain(done.identity.method);
  }
  // EXISTING MAPPING RESTORATION: reopening the enroll dialog proposes 11
  const restored = await proposedTerminalUserId(SERIAL, importerA1);
  expect(restored).toBe("11");
  // the importer is ENROLLED now
  const imp = await db.importer.findUnique({ where: { id: importerA1 }, select: { biometricStatus: true } });
  expect(imp?.biometricStatus).toBe("ENROLLED");
});

test("startEnrollment rejects a terminal-user id already mapped to another importer", async () => {
  await expect(startEnrollment(admin, { importerId: importerA2, deviceKey: SERIAL, terminalUserId: "11" })).rejects.toThrow(
    FriendlyApiError
  );
  await expect(startEnrollment(admin, { importerId: importerA2, deviceKey: SERIAL, terminalUserId: "11" })).rejects.toThrow(
    /دیگری/
  );
});

test("startEnrollment rejects an importer already mapped to another terminal user", async () => {
  await expect(startEnrollment(admin, { importerId: importerA1, deviceKey: SERIAL, terminalUserId: "77" })).rejects.toThrow(
    /قابل تغییر نیست/
  );
});

test("simultaneous PENDING enrollments on one device+user conflict between officers", async () => {
  // officer A (port owner) starts an enrollment for user 12
  const first = await startEnrollment(officerA, { importerId: importerA2, deviceKey: SERIAL, terminalUserId: "12" });
  // officer B… cannot even see the device (port restriction) — use admin
  // as the second COMPETING workstation on the same port.
  await expect(startEnrollment(admin, { importerId: importerA2, deviceKey: SERIAL, terminalUserId: "12" })).rejects.toThrow(
    /درخواست ثبت فعال دیگری/
  );
  // the SAME owner may replace their own pending request cleanly
  const again = await startEnrollment(officerA, { importerId: importerA2, deviceKey: SERIAL, terminalUserId: "12" });
  expect(again.enrollmentId).not.toBe(first.enrollmentId);
  const firstRow = await db.terminalEnrollment.findUnique({ where: { id: first.enrollmentId }, select: { status: true } });
  expect(firstRow?.status).toBe("CANCELED");
  // release the pending request so the completion-matrix tests start clean
  await cancelEnrollment(officerA, again.enrollmentId);
});

// ============================================================
// 2. completion matrix — wrong/old/expired/reused scans + ownership
// (importerA2 / user 12 — importerA2 has NO mapping yet; a completed
//  (device,12)→A2 identity keeps later same-pair enrollments valid)
// ============================================================

test("a scan from ANOTHER terminal user never completes the enrollment", async () => {
  const wrongScan = await freshScan({ userId: "13" }); // enrollment expects 12
  const enrollment = await startEnrollment(admin, { importerId: importerA2, deviceKey: SERIAL, terminalUserId: "12" });
  const done = await completeEnrollment(admin, enrollment.enrollmentId, wrongScan.scanId);
  expect(done.ok).toBe(false);
  if (!done.ok) expect(done.message).toContain("مطابقت");
});

test("a scan received BEFORE the enrollment started is never offered to it", async () => {
  // ingested first, then the enrollment is created 6 s later — the scan
  // is still within the 90 s freshness window but PREDATES the request
  const early = await freshScan({ userId: "12" });
  await sleep(6000);
  const enrollment = await startEnrollment(admin, { importerId: importerA2, deviceKey: SERIAL, terminalUserId: "12" });
  const enrollmentRow = await db.terminalEnrollment.findUnique({
    where: { id: enrollment.enrollmentId },
    select: { createdAt: true },
  });
  const offered = await latestEnrollmentScan(
    { deviceKey: SERIAL, terminalUserId: "12", createdAt: enrollmentRow!.createdAt },
    0
  );
  expect(offered).toBeNull(); // a pre-enrollment scan can never confirm the request

  // a scan received AFTER the request started IS offered (SSE path)
  const late = await freshScan({ userId: "12" });
  const offeredLate = await latestEnrollmentScan(
    { deviceKey: SERIAL, terminalUserId: "12", createdAt: enrollmentRow!.createdAt },
    0
  );
  expect(offeredLate?.scanId).toBe(late.scanId);
  // consume it so later tests start clean
  await cancelEnrollment(admin, enrollment.enrollmentId);
  await consumeTerminalScan(late.scanId, { deviceKey: SERIAL, terminalUserId: "12" });
}, 20_000); // the 6 s clock-tolerance wait exceeds bun's 5 s default

test("non-owner completion is refused (owner-bound requests)", async () => {
  const scan = await freshScan({ userId: "12" });
  const enrollment = await startEnrollment(admin, { importerId: importerA2, deviceKey: SERIAL, terminalUserId: "12" });
  const done = await completeEnrollment(officerA, enrollment.enrollmentId, scan.scanId);
  expect(done.ok).toBe(false);
  if (!done.ok) expect(done.message).toContain("نشست شما");
  // cancel to clean state
  await cancelEnrollment(admin, enrollment.enrollmentId);
});

test("expired enrollments cannot complete; sweep marks them EXPIRED", async () => {
  const scan = await freshScan({ userId: "12" });
  const enrollment = await startEnrollment(admin, { importerId: importerA2, deviceKey: SERIAL, terminalUserId: "12" });
  await db.terminalEnrollment.update({
    where: { id: enrollment.enrollmentId },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  const done = await completeEnrollment(admin, enrollment.enrollmentId, scan.scanId);
  expect(done.ok).toBe(false);
  if (!done.ok) expect(done.message).toContain("پایان");
  await expireStaleEnrollments();
  const row = await db.terminalEnrollment.findUnique({ where: { id: enrollment.enrollmentId }, select: { status: true } });
  expect(row?.status).toBe("EXPIRED");
});

test("successful completion consumes the scan EXACTLY ONCE (replay refused)", async () => {
  const scan = await freshScan({ userId: "12" });
  const enrollment = await startEnrollment(admin, { importerId: importerA2, deviceKey: SERIAL, terminalUserId: "12" });
  const done = await completeEnrollment(admin, enrollment.enrollmentId, scan.scanId);
  expect(done.ok).toBe(true);

  // REUSED scan: the identity now exists (mapping set above), so a new
  // enrollment for the SAME user+importer is allowed (idempotent) — but
  // the SAME scanId is already consumed and can never confirm anything.
  const again = await startEnrollment(admin, { importerId: importerA2, deviceKey: SERIAL, terminalUserId: "12" });
  const replay = await completeEnrollment(admin, again.enrollmentId, scan.scanId);
  expect(replay.ok).toBe(false);
  if (!replay.ok) expect(replay.message).toContain("قبلاً مصرف");

  // consumeTerminalScan double-consumption guard, direct
  const direct = await consumeTerminalScan(scan.scanId, { deviceKey: SERIAL, terminalUserId: "12" });
  expect(direct.ok).toBe(false);
  if (!direct.ok) expect(direct.reason).toBe("ALREADY_USED");
});

test("a scan pinned to device+user cannot complete an enrollment of ANOTHER device", async () => {
  // second device on checkpoint A
  const serial2 = `${SERIAL}X`;
  await db.terminalDevice.create({
    data: {
      serial: serial2,
      name: "دستگاه آزمون دوم",
      transport: "ADMS_SERVER",
      checkpointId: deviceCheckpointId,
      isEnabled: true,
      createdById: admin.id,
    },
  });
  try {
    const scan = await freshScan({ userId: "12", deviceKey: SERIAL });
    const enrollment = await startEnrollment(admin, { importerId: importerA2, deviceKey: serial2, terminalUserId: "12" });
    const done = await completeEnrollment(admin, enrollment.enrollmentId, scan.scanId);
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.message).toContain("دستگاه");
  } finally {
    // enrollment rows reference the device serial (FK) — clear first
    await db.terminalEnrollment.deleteMany({ where: { deviceKey: serial2 } });
    await db.terminalDevice.delete({ where: { serial: serial2 } });
  }
});

// ============================================================
// 3. officer port restrictions
// ============================================================

test("an OFFICER of another port cannot start enrollment on this device", async () => {
  await expect(startEnrollment(officerB, { importerId: importerA1, deviceKey: SERIAL, terminalUserId: "12" })).rejects.toThrow(
    FriendlyApiError
  );
});

test("identity resolution respects importer + membership status", async () => {
  const identity = await resolveTerminalIdentity(SERIAL, "12");
  expect(identity?.importerId).toBe(importerA2);

  // deactivate the importer → resolution returns null
  await db.importer.update({ where: { id: importerA2 }, data: { status: "INACTIVE" } });
  const deactivated = await resolveTerminalIdentity(SERIAL, "12");
  expect(deactivated).toBeNull();
  await db.importer.update({ where: { id: importerA2 }, data: { status: "ACTIVE" } });

  // suspended group membership → resolution returns null
  await db.importer.update({ where: { id: importerA2 }, data: { membershipStatus: "SUSPENDED" } });
  const suspended = await resolveTerminalIdentity(SERIAL, "12");
  expect(suspended).toBeNull();
  await db.importer.update({ where: { id: importerA2 }, data: { membershipStatus: "ACTIVE" } });
  const restored = await resolveTerminalIdentity(SERIAL, "12");
  expect(restored?.importerId).toBe(importerA2);
});

// ============================================================
// 4. ingestion rules (replay + non-biometric + freshness)
// ============================================================

test("ingestion dedups replays and rejects card/password modes", async () => {
  const ms = Date.now() + 270 * 60_000;
  const first = await ingestTerminalScan({ serial: SERIAL, terminalUserId: "44", punch: 1, verify: 1, deviceLocalMs: ms, timezoneOffsetMinutes: 270 });
  expect(first.ok).toBe(true);
  const replay = await ingestTerminalScan({ serial: SERIAL, terminalUserId: "44", punch: 1, verify: 1, deviceLocalMs: ms, timezoneOffsetMinutes: 270 });
  expect(replay.ok).toBe(true);
  if (replay.ok) expect(replay.duplicate).toBe(true);

  const card = await ingestTerminalScan({ serial: SERIAL, terminalUserId: "44", punch: 0, verify: 2, deviceLocalMs: ms, timezoneOffsetMinutes: 270 });
  expect(card.ok).toBe(false);
  if (!card.ok) expect(card.reason).toBe("NON_BIOMETRIC");

  const password = await ingestTerminalScan({ serial: SERIAL, terminalUserId: "44", punch: 0, verify: 0, deviceLocalMs: ms, timezoneOffsetMinutes: 270 });
  expect(password.ok).toBe(false);
  if (!password.ok) expect(password.reason).toBe("NON_BIOMETRIC");

  const future = await ingestTerminalScan({ serial: SERIAL, terminalUserId: "44", punch: 0, verify: 1, deviceLocalMs: ms + 3600_000, timezoneOffsetMinutes: 270 });
  expect(future.ok).toBe(false);
  if (!future.ok) expect(future.reason).toBe("STALE");

  // a STALE scan never even enters the pipeline (fixture-level proof of
  // the 90 s window — see classifyScanEligibility)
  const stale = await ingestTerminalScan({ serial: SERIAL, terminalUserId: "44", punch: 2, verify: 1, deviceLocalMs: ms - 120_000, timezoneOffsetMinutes: 270 });
  expect(stale.ok).toBe(false);
  if (!stale.ok) expect(stale.reason).toBe("STALE");
});
