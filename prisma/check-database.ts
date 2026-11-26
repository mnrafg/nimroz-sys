import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
try {
  const [connection] = await db.$queryRaw<{ version: string; databaseName: string }[]>`
    SELECT VERSION() AS version, DATABASE() AS databaseName
  `;
  const [users, importers, entries] = await Promise.all([
    db.user.count(), db.importer.count(), db.importEntry.count(),
  ]);
  console.log(`Connected to ${connection.databaseName} (${connection.version}).`);
  console.log(`Users: ${users}; importers: ${importers}; import entries: ${entries}.`);
} finally {
  await db.$disconnect();
}
