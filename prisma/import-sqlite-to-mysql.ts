/**
 * Copy an existing SQLite snapshot into an EMPTY MySQL database.
 * Run schema synchronization first, then:
 *   bun prisma/import-sqlite-to-mysql.ts path/to/backup.db
 * The source is read-only. Existing MySQL records are never overwritten.
 * Audit links to deleted users become null; their original IDs are retained
 * in a separate migration audit entry. All other invalid relations abort.
 */
import { Database } from "bun:sqlite";
import { Prisma, PrismaClient } from "@prisma/client";
import { resolve } from "node:path";

const sourcePath = process.argv[2];
if (!sourcePath) throw new Error("Supply the path to a SQLite backup.");
if (!process.env.DATABASE_URL?.startsWith("mysql://")) {
  throw new Error("DATABASE_URL must point to MySQL.");
}
const source = new Database(resolve(sourcePath), { readonly: true });
const target = new PrismaClient();
const quote = (name: string) => `\`${name.replace(/`/g, "``")}\``;
const models = Prisma.dmmf.datamodel.models;
type Row = Record<string, unknown>;

function convert(value: unknown, field: { type: string }): unknown {
  if (value === null) return null;
  if (field.type === "DateTime") {
    const date = new Date(value as string | number);
    if (!Number.isFinite(date.getTime())) throw new Error("Invalid source date.");
    return date;
  }
  if (field.type === "Boolean") return Boolean(value);
  return value;
}

function comparable(value: unknown, field: { type: string }): string {
  const converted = convert(value, field);
  if (converted instanceof Date) return converted.toISOString();
  if (typeof converted === "bigint") return converted.toString();
  return JSON.stringify(converted);
}

try {
  const integrity = source.query("PRAGMA integrity_check").get() as Row;
  if (Object.values(integrity)[0] !== "ok") throw new Error("SQLite integrity check failed.");
  const tables = source.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  const sourceTables = new Set(tables.map(t => t.name));
  const targetTables = new Set(models.map(m => m.dbName ?? m.name));
  for (const name of sourceTables) {
    if (!targetTables.has(name)) throw new Error(`Source table ${name} is missing from the MySQL schema.`);
  }
  const snapshot = models.map(model => {
    const name = model.dbName ?? model.name;
    const fields = model.fields.filter(f => f.kind !== "object");
    const rows = sourceTables.has(name) ? source.query(`SELECT * FROM ${quote(name)}`).all() as Row[] : [];
    if (sourceTables.has(name)) {
      const columns = source.query(`PRAGMA table_info(${quote(name)})`).all() as { name: string }[];
      for (const column of columns) {
        if (!fields.some(f => (f.dbName ?? f.name) === column.name)) {
          throw new Error(`Source column ${name}.${column.name} is missing from the MySQL schema.`);
        }
      }
    }
    return { name, fields, rows };
  });
  const userIds = new Set(snapshot.find(t => t.name === "User")!.rows.map(row => row.id));
  const orphanedAuditActors: { auditLogId: unknown; originalUserId: unknown }[] = [];
  for (const row of snapshot.find(t => t.name === "AuditLog")!.rows) {
    if (row.userId !== null && !userIds.has(row.userId)) {
      orphanedAuditActors.push({ auditLogId: row.id, originalUserId: row.userId });
      row.userId = null;
    }
  }

  await target.$transaction(async tx => {
    for (const { name } of snapshot) {
      const [count] = await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM ${quote(name)}`);
      if (Number(count.n) !== 0) throw new Error(`MySQL table ${name} is not empty; import aborted.`);
    }
    // Some importer/group relations are circular. Keep this on the same
    // transaction connection and explicitly validate every FK before commit.
    await tx.$executeRawUnsafe("SET FOREIGN_KEY_CHECKS = 0");
    try {
      for (const { name, fields, rows } of snapshot) {
        for (const row of rows) {
          const present = fields.filter(f => Object.hasOwn(row, f.dbName ?? f.name));
          const columns = present.map(f => quote(f.dbName ?? f.name)).join(", ");
          const values = present.map(f => convert(row[f.dbName ?? f.name], f));
          await tx.$executeRawUnsafe(`INSERT INTO ${quote(name)} (${columns}) VALUES (${present.map(() => "?").join(", ")})`, ...values);
        }
      }
      for (const model of models) {
        const table = quote(model.dbName ?? model.name);
        for (const relation of model.fields.filter(f => (f.relationFromFields?.length ?? 0) > 0)) {
          const referenced = models.find(m => m.name === relation.type)!;
          const from = relation.relationFromFields!.map(n => model.fields.find(f => f.name === n)!);
          const to = relation.relationToFields!.map(n => referenced.fields.find(f => f.name === n)!);
          const join = from.map((f, i) => `a.${quote(f.dbName ?? f.name)} = b.${quote(to[i].dbName ?? to[i].name)}`).join(" AND ");
          const nonNull = from.map(f => `a.${quote(f.dbName ?? f.name)} IS NOT NULL`).join(" AND ");
          const [count] = await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM ${table} a LEFT JOIN ${quote(referenced.dbName ?? referenced.name)} b ON ${join} WHERE ${nonNull} AND b.${quote(to[0].dbName ?? to[0].name)} IS NULL`);
          if (Number(count.n)) throw new Error(`Invalid relationship: ${model.name}.${relation.name}`);
        }
      }
      for (const { name, fields, rows } of snapshot) {
        const imported = await tx.$queryRawUnsafe<Row[]>(`SELECT * FROM ${quote(name)}`);
        const canonical = (row: Row) => JSON.stringify(fields.map(f => comparable(row[f.dbName ?? f.name], f)));
        const expected = rows.map(canonical).sort();
        const actual = imported.map(canonical).sort();
        if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error(`Data verification failed for ${name}.`);
      }
      await tx.auditLog.create({
        data: {
          action: "DATABASE_MIGRATION",
          recordType: "SYSTEM",
          newValues: JSON.stringify({
            source: "SQLite",
            importedTables: Object.fromEntries(snapshot.map(t => [t.name, t.rows.length])),
            orphanedAuditActors,
          }),
        },
      });
    } finally {
      await tx.$executeRawUnsafe("SET FOREIGN_KEY_CHECKS = 1");
    }
  }, { maxWait: 10000, timeout: 120000 });
  for (const { name, rows } of snapshot) console.log(`${name}: ${rows.length} records verified`);
  if (orphanedAuditActors.length) {
    console.log(`${orphanedAuditActors.length} audit links to deleted users cleared; original IDs saved in the migration audit entry.`);
  }
  console.log("Import committed. All source values and foreign keys verified.");
} finally {
  source.close();
  await target.$disconnect();
}
