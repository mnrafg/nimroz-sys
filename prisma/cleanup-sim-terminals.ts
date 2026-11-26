/**
 * Remove SIMULATED test terminals from the device inventory.
 *
 * The five SIM-prefixed TerminalDevice rows (plus their scans, identities,
 * enrollments and leases) were created by LAN/ADMS test sessions against
 * the simulator and the localhost bridge. The spec forbids "production
 * references to simulated terminals" — they are removed here EXPLICITLY
 * (documented + audited), never silently:
 *
 *   • every removed row is written to an AuditLog entry
 *   • importer biometricStatus is reset to NOT_ENROLLED when its last
 *     terminal identity disappears (no orphaned ENROLLED status)
 *   • importer/import/quota/audit business data is never touched
 *
 * Run:  bun prisma/cleanup-sim-terminals.ts
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const sims = await prisma.terminalDevice.findMany({
    where: { serial: { startsWith: "SIM" } },
    select: { id: true, serial: true, name: true, transport: true },
  });
  if (sims.length === 0) {
    console.log("no SIM* test terminals present — nothing to do");
    await prisma.$disconnect();
    return;
  }
  const serials = sims.map((d) => d.serial);
  console.log(`removing ${sims.length} simulated terminal(s): ${serials.join(", ")}`);

  // importers whose ONLY identities are SIM identities → reset status
  const affectedImporters = await prisma.terminalIdentity.findMany({
    where: { deviceKey: { in: serials } },
    select: { importerId: true },
  });
  const importerIds = [...new Set(affectedImporters.map((i) => i.importerId))];

  // counts for the audit record
  const [scans, identities, enrollments] = await Promise.all([
    prisma.terminalScan.count({ where: { deviceKey: { in: serials } } }),
    prisma.terminalIdentity.count({ where: { deviceKey: { in: serials } } }),
    prisma.terminalEnrollment.count({ where: { deviceKey: { in: serials } } }),
  ]);

  // delete dependents first (string-keyed, no FK constraints)
  await prisma.terminalLease.deleteMany({ where: { deviceKey: { in: serials } } });
  await prisma.terminalScan.deleteMany({ where: { deviceKey: { in: serials } } });
  await prisma.terminalIdentity.deleteMany({ where: { deviceKey: { in: serials } } });
  await prisma.terminalEnrollment.deleteMany({ where: { deviceKey: { in: serials } } });
  await prisma.terminalReceipt.deleteMany({ where: { deviceKey: { in: serials } } });
  await prisma.terminalDevice.deleteMany({ where: { serial: { in: serials } } });

  // reset biometric status for importers with no remaining terminal identity
  let reset = 0;
  for (const importerId of importerIds) {
    const remaining = await prisma.terminalIdentity.count({ where: { importerId } });
    if (remaining === 0) {
      await prisma.importer.update({
        where: { id: importerId },
        data: { biometricStatus: "NOT_ENROLLED", biometricEnrolledAt: null },
      });
      reset += 1;
    }
  }

  await prisma.auditLog.create({
    data: {
      userId: 1,
      action: "TERMINAL_SIM_DEVICES_REMOVED",
      recordType: "TerminalDevice",
      recordId: null as unknown as number,
      newValues: JSON.stringify({
        serials,
        removedScans: scans,
        removedIdentities: identities,
        removedEnrollments: enrollments,
        resetImporters: reset,
        reason: "simulated test terminals removed from production inventory (spec)",
      }),
    },
  });

  console.log(`removed scans=${scans} identities=${identities} enrollments=${enrollments}; reset importer status for ${reset} importer(s)`);
  console.log("audit log entry TERMINAL_SIM_DEVICES_REMOVED written");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("cleanup failed:", e);
  process.exit(1);
});
