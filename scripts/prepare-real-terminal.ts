/**
 * Prepare the device inventory for the REAL physical terminal.
 *
 * Spec (section 5):
 *   Device: ZKTeco uFace800 Plus — Local IP 192.168.1.168 — TCP 4370.
 *   Use the actual physical serial; do NOT generate or copy a sample
 *   serial. Simulated devices must never be registered as operational
 *   terminals.
 *
 * What this script does (explicitly, never silently — every row change
 * is written to AuditLog):
 *   1. Removes the leftover SAMPLE device `ABC123` (a manual test entry
 *      with a made-up serial). It is disabled, has no scans, no
 *      identities, no enrollments and no leases — nothing references it.
 *   2. Repoints the REAL terminal record (serial JYM6244400083, the
 *      serial read from the physical uFace800 Plus) to the device's
 *      actual LAN address 192.168.1.168:4370 and gives it a clear
 *      operational name instead of the previous "new test".
 *
 * Business data (importers, entries, quotas, audit history) is never
 * touched. The runtime LAN serial-verification in terminal-manager
 * still confirms the hardware serial at every connect — a record whose
 * serial does not match the physical device can never go online.
 *
 * Run:  bun scripts/prepare-real-terminal.ts
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const REAL_SERIAL = "JYM6244400083"; // read from the physical uFace800 Plus
const REAL_HOST = "192.168.1.168"; // device LAN address (spec section 5)
const REAL_PORT = 4370; // ZKTeco standard TCP port
const REAL_NAME = "ترمینال uFace800 Plus — بندر نیمروز";
const SAMPLE_SERIAL = "ABC123"; // manual test entry with a sample serial

async function main() {
  const sample = await prisma.terminalDevice.findUnique({
    where: { serial: SAMPLE_SERIAL },
    include: {
      identities: { select: { id: true } },
      enrollments: { select: { id: true } },
      leases: { select: { id: true } },
    },
  });

  if (sample) {
    const scans = await prisma.terminalScan.count({ where: { deviceKey: SAMPLE_SERIAL } });
    const dependent =
      sample.identities.length + sample.enrollments.length + sample.leases.length + scans;
    if (dependent > 0) {
      console.log(
        `sample device ${SAMPLE_SERIAL} has ${dependent} dependent row(s) — NOT removed (review manually)`
      );
    } else {
      await prisma.terminalDevice.delete({ where: { serial: SAMPLE_SERIAL } });
      await prisma.auditLog.create({
        data: {
          action: "TERMINAL_DEVICE_REMOVE_SIM_SAMPLE",
          recordType: "TerminalDevice",
          recordId: sample.id,
          oldValues: JSON.stringify({
            serial: sample.serial,
            name: sample.name,
            transport: sample.transport,
            host: sample.host,
            port: sample.port,
            isEnabled: sample.isEnabled,
          }),
          newValues: null,
        },
      });
      console.log(`removed sample device ${SAMPLE_SERIAL} (audited, had no dependents)`);
    }
  } else {
    console.log(`sample device ${SAMPLE_SERIAL} not present — nothing to remove`);
  }

  const real = await prisma.terminalDevice.findUnique({ where: { serial: REAL_SERIAL } });
  if (!real) {
    console.log(
      `real terminal ${REAL_SERIAL} not registered yet — register it via «تنظیمات دستگاه‌های بایومتریک» with host ${REAL_HOST}:${REAL_PORT} (the serial must be the one shown on the physical device)`
    );
  } else {
    const changed =
      real.host !== REAL_HOST || real.port !== REAL_PORT || real.name !== REAL_NAME;
    if (changed) {
      await prisma.terminalDevice.update({
        where: { serial: REAL_SERIAL },
        data: { host: REAL_HOST, port: REAL_PORT, name: REAL_NAME },
      });
      await prisma.auditLog.create({
        data: {
          action: "TERMINAL_DEVICE_REALIGN_REAL_DEVICE",
          recordType: "TerminalDevice",
          recordId: real.id,
          oldValues: JSON.stringify({ name: real.name, host: real.host, port: real.port }),
          newValues: JSON.stringify({ name: REAL_NAME, host: REAL_HOST, port: REAL_PORT }),
        },
      });
      console.log(`realigned ${REAL_SERIAL}: host=${REAL_HOST} port=${REAL_PORT} name updated (audited)`);
    } else {
      console.log(`real terminal ${REAL_SERIAL} already points at ${REAL_HOST}:${REAL_PORT}`);
    }
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("ERR:", e);
  process.exit(1);
});
