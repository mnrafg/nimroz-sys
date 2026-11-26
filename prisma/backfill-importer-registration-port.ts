/**
 * One-time safe backfill (run: bun run prisma/backfill-importer-registration-port.ts)
 *
 * Registers the registration-port ownership of EXISTING importers:
 * each importer's registeredCheckpointId = checkpoint of its EARLIEST
 * entry (the port where it first appeared operationally). Importers with
 * no entries stay NULL = centrally registered (visible to all ports,
 * biometric identification / duplicate checks unaffected).
 *
 * Idempotent: only touches importers where registeredCheckpointId IS NULL
 * AND an earliest entry exists — never overwrites an explicit assignment.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const unassigned = await db.importer.findMany({
    where: { registeredCheckpointId: null },
    select: { id: true, importerCode: true },
  });

  let updated = 0;
  for (const imp of unassigned) {
    const first = await db.importEntry.findFirst({
      where: { importerId: imp.id },
      orderBy: [{ importDatetime: "asc" }, { id: "asc" }],
      select: { checkpointId: true },
    });
    if (first) {
      await db.importer.update({
        where: { id: imp.id },
        data: { registeredCheckpointId: first.checkpointId },
      });
      updated++;
      console.log(`  IMP ${imp.importerCode} -> checkpoint ${first.checkpointId}`);
    }
  }
  console.log(`Backfill done: ${updated} importer(s) assigned, ${unassigned.length - updated} left central (null).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
