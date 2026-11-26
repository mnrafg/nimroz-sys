/** Widen only photo/audit storage after the SQLite → MySQL conversion.
 * Repeatable and non-destructive. No reset, db push, or record updates.
 * Run: bun prisma/migrate-mysql-importer-text.ts
 */
import { PrismaClient } from "@prisma/client";
const client = new PrismaClient();
try {
  if (!process.env.DATABASE_URL?.startsWith("mysql://")) {
    throw new Error("This migration requires the configured MySQL database.");
  }
  const columns = await client.$queryRaw<Array<{ TABLE_NAME: string; COLUMN_NAME: string; DATA_TYPE: string }>>`
    SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
    AND ((TABLE_NAME = 'Importer' AND COLUMN_NAME = 'photoData')
      OR (TABLE_NAME = 'AuditLog' AND COLUMN_NAME IN ('oldValues', 'newValues')))
  `;
  if (columns.length !== 3) throw new Error("Expected Importer photo and AuditLog columns were not found.");
  const photo = columns.find(c => c.TABLE_NAME === "Importer");
  if (!["mediumtext", "longtext"].includes(photo!.DATA_TYPE.toLowerCase())) {
    await client.$executeRawUnsafe("ALTER TABLE `Importer` MODIFY COLUMN `photoData` MEDIUMTEXT NULL");
  }
  const audit = columns.filter(c => c.TABLE_NAME === "AuditLog");
  if (audit.some(c => c.DATA_TYPE.toLowerCase() !== "longtext")) {
    await client.$executeRawUnsafe("ALTER TABLE `AuditLog` MODIFY COLUMN `oldValues` LONGTEXT NULL, MODIFY COLUMN `newValues` LONGTEXT NULL");
  }
  console.log("Importer photo and audit JSON columns are widened; existing records preserved.");
} finally {
  await client.$disconnect();
}
