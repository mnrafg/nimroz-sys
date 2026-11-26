/**
 * Reviewed migration — REMOVE the legacy biometric stacks.
 *
 * Removes (after explicit verification):
 *   • ImporterFingerprint           — old USB-scanner template store
 *   • DeviceGateway                 — Windows SDK gateway registration/pairing
 *   • BiometricDevice               — gateway-routed device inventory
 *   • BiometricUserIdentity         — centrally allocated website user IDs
 *   • DeviceUserMapping             — legacy per-device identity mapping
 *   • DeviceOperation               — gateway job queue
 *   • DeviceEvent                   — gateway event store
 *   • LiveIdSession                 — gateway live identification sessions
 *   • Importer.biometricFingers     — cached finger count (bridge-only)
 *
 * The retained terminal biometric stack (TerminalDevice, TerminalIdentity,
 * TerminalEnrollment, TerminalScan, TerminalLease, TerminalReceipt,
 * TerminalReceiverConfig) and ALL business data (importers, imports,
 * quotas, users, audit logs) are untouched.
 *
 * SAFETY CONTRACT
 *  1. Backs up the SQLite database file (including -wal/-shm) first.
 *  2. Counts every legacy table; REFUSES to drop a table that still has
 *     rows (report the counts — a separate data-migration decision is
 *     then required; nothing is silently deleted).
 *  3. Drops the empty tables + the biometricFingers column via raw SQL.
 *  4. Verifies the drop and prints the final table list.
 *
 * Run:  bun prisma/migrate-remove-legacy-biometric.ts
 * (The Prisma schema no longer contains these models; `prisma db push`
 *  performs the same removal — this script is the reviewed, auditable
 *  path that documents and verifies it.)
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { copyFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const LEGACY_TABLES = [
  "ImporterFingerprint",
  "DeviceGateway",
  "BiometricDevice",
  "BiometricUserIdentity",
  "DeviceUserMapping",
  "DeviceOperation",
  "DeviceEvent",
  "LiveIdSession",
] as const;

const LEGACY_COLUMNS = [{ table: "Importer", column: "biometricFingers" }] as const;

const prisma = new PrismaClient();

function ts(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function tableExists(name: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ name: string }[]>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    name
  );
  return rows.length > 0;
}

async function rowCount(name: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ c: number }[]>(`SELECT COUNT(*) as c FROM "${name}"`);
  return Number(rows[0]?.c ?? 0);
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ name: string }[]>(`PRAGMA table_info("${table}")`);
  return rows.some((r) => r.name === column);
}

async function main() {
  console.log("== Migration: remove legacy biometric tables ==");

  // ---- 1. backup ----
  const url = process.env.DATABASE_URL ?? "";
  const dbFile = url.replace(/^file:/, "");
  if (dbFile && existsSync(dbFile)) {
    const dir = join(dbFile, "..", "backups");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, `custom-pre-legacy-removal-${ts()}.db`);
    copyFileSync(dbFile, target);
    const wal = `${dbFile}-wal`;
    if (existsSync(wal)) copyFileSync(wal, `${target}-wal`);
    console.log(`backup written: ${target}`);
  } else {
    console.warn("DATABASE_URL file not found — proceeding WITHOUT backup (dev only).");
  }

  // ---- 2. verify emptiness ----
  const populated: string[] = [];
  for (const t of LEGACY_TABLES) {
    if (!(await tableExists(t))) {
      console.log(`  ${t}: table absent (already removed)`);
      continue;
    }
    const c = await rowCount(t);
    console.log(`  ${t}: ${c} row(s)`);
    if (c > 0) populated.push(`${t} (${c})`);
  }
  if (populated.length > 0) {
    console.error(
      `REFUSING TO DROP — populated legacy tables found: ${populated.join(", ")}. ` +
        `Migrate or archive those rows first; nothing was deleted.`
    );
    process.exit(1);
  }

  // ---- 3. drop ----
  for (const t of LEGACY_TABLES) {
    if (await tableExists(t)) {
      await prisma.$executeRawUnsafe(`DROP TABLE "${t}"`);
      console.log(`  dropped table ${t}`);
    }
  }
  for (const { table, column } of LEGACY_COLUMNS) {
    if (await columnExists(table, column)) {
      await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" DROP COLUMN "${column}"`);
      console.log(`  dropped column ${table}.${column}`);
    }
  }

  // ---- 4. verify ----
  const remaining: string[] = [];
  for (const t of LEGACY_TABLES) {
    if (await tableExists(t)) remaining.push(t);
  }
  if (remaining.length > 0) {
    console.error(`VERIFICATION FAILED — still present: ${remaining.join(", ")}`);
    process.exit(1);
  }
  console.log("== Migration complete: legacy biometric tables removed, business data preserved ==");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("migration failed:", e);
  process.exit(1);
});
