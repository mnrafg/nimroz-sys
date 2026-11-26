/**
 * Terminal biometric stack migration — additive, repeatable, safe.
 *
 * Usage:  bun prisma/migrate-terminal.ts
 *
 * What it does, in order:
 *  1. Verifies the intended application database (db/custom.db present,
 *     core application tables reachable through Prisma) — never touches
 *     another application's SQLite file.
 *  2. Creates a CONSISTENT backup including committed WAL data
 *     (SQLite VACUUM INTO through bun:sqlite, which checkpoints WAL).
 *  3. Applies the additive Prisma schema (only NEW Terminal* tables are
 *     created; existing importers/accounts/quotas/history/terminal
 *     links/secrets are never reset or rewritten).
 *
 * This script NEVER uses `db push --accept-data-loss`, NEVER resets the
 * database, and NEVER replaces it with the reference application's
 * database. Re-running it is always safe.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";

const ROOT = resolve(import.meta.dir, "..");
const DB_FILE = join(ROOT, "db", "custom.db");

// 1 — verify the intended application database
if (!existsSync(DB_FILE)) {
  console.error(`[migrate-terminal] نشست: فایل بانک اطلاعاتی در ${DB_FILE} وجود ندارد.`);
  process.exit(1);
}
const probe = new Database(DB_FILE, { readonly: true });
const coreTables = ["User", "Importer", "ImportEntry", "BorderCheckpoint"];
const names = probe
  .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
  .all()
  .map((r) => r.name);
probe.close();
for (const t of coreTables) {
  if (!names.includes(t)) {
    console.error(
      `[migrate-terminal] فایل بانک اطلاعاتی اپلیکیشن مورد نظر نیست (جدول ${t} یافت نشد). لغو شد.`
    );
    process.exit(1);
  }
}
console.log("[migrate-terminal] بانک اطلاعاتی مورد نظر تأیید شد:", DB_FILE);

// 2 — consistent backup (VACUUM INTO checkpoints WAL into one file)
const backupDir = join(ROOT, "db", "backups");
mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = join(backupDir, `pre-terminal-${stamp}.db`);
const bak = new Database(DB_FILE);
bak.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
bak.close();
console.log("[migrate-terminal] نسخه پشتیبان ایجاد شد:", backupPath);

// 3 — additive schema application (plain db push; never accept-data-loss)
console.log("[migrate-terminal] اعمال اسکیمای افزایشی…");
execFileSync("bunx", ["prisma", "db", "push", "--skip-generate"], {
  cwd: ROOT,
  stdio: "inherit",
});
console.log("[migrate-terminal] تولید کلاینت Prisma…");
execFileSync("bunx", ["prisma", "generate"], { cwd: ROOT, stdio: "inherit" });

console.log("[migrate-terminal] کامل شد — جدول‌های جدید Terminal* اضافه شدند؛ معلومات موجود حفظ شد.");
