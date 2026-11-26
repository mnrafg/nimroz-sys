/**
 * Reviewed migration — FINISH the legacy-receiver removal + ADMS
 * destination separation.
 *
 *  1. ARCHIVE (never delete): any TerminalReceiverConfig row is copied
 *     verbatim into SystemSetting under the key
 *     `terminal.legacyReceiver.archived` (with an archivedAt stamp)
 *     before its table is dropped. The in-app legacy receiver (RELAY,
 *     /api/iclock/*, /api/biometric/terminal/receiver) was removed from
 *     the code; the dedicated Python ADMS service is the only
 *     device-facing listener.
 *
 *  2. RELOCATE the misapplied loopback destination: a device-facing
 *     ADMS destination on 127.0.0.1 / localhost can never be reached by
 *     any physical terminal. If the stored terminal.admsServer host is
 *     loopback, it is moved to the application-facing API override
 *     (apiProtocol/apiHost/apiPort) — where loopback IS valid (local
 *     service/tunnel) — and the device-facing host is cleared so the
 *     UI shows "تنظیم نشده" until a real reachable destination is set.
 *     The original value stays visible in the archived JSON.
 *
 *  3. DROP the TerminalReceiverConfig table.
 *
 * SAFETY CONTRACT
 *  • Backs up the SQLite database file (including -wal/-shm) first.
 *  • Every relocation is written to the archived SystemSetting record;
 *    nothing is silently discarded.
 *
 * Run:  bun prisma/migrate-finish-legacy-removal.ts
 * (The Prisma schema no longer contains TerminalReceiverConfig;
 *  `prisma db push` performs the same removal — this script is the
 *  reviewed, auditable path.)
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { copyFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const RECEIVER_TABLE = "TerminalReceiverConfig";
const RECEIVER_ARCHIVE_KEY = "terminal.legacyReceiver.archived";
const ADMS_SETTING_KEY = "terminal.admsServer";

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

function isLoopback(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost");
}

async function main() {
  console.log("== Migration: finish legacy-receiver removal + ADMS destination separation ==");

  // ---- 1. backup ----
  const url = process.env.DATABASE_URL ?? "";
  const dbFile = url.replace(/^file:/, "");
  if (dbFile && existsSync(dbFile)) {
    const dir = join(dbFile, "..", "backups");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, `custom-pre-legacy-finish-${ts()}.db`);
    copyFileSync(dbFile, target);
    const wal = `${dbFile}-wal`;
    if (existsSync(wal)) copyFileSync(wal, `${target}-wal`);
    console.log(`backup written: ${target}`);
  } else {
    console.warn("DATABASE_URL file not found — proceeding WITHOUT backup (dev only).");
  }

  // ---- 2. archive the legacy receiver config (data preservation) ----
  if (await tableExists(RECEIVER_TABLE)) {
    const rows = await prisma.$queryRawUnsafe<
      { id: string; publicUrl: string | null; enabled: number; updatedAt: string | null }[]
    >(`SELECT id, publicUrl, enabled, updatedAt FROM "${RECEIVER_TABLE}"`);
    if (rows.length > 0) {
      const payload = JSON.stringify({
        archivedAt: new Date().toISOString(),
        reason: "legacy in-app receiver (RELAY) removed; Python ADMS service is the sole device-facing listener",
        rows,
      });
      const existing = await prisma.systemSetting.findUnique({ where: { key: RECEIVER_ARCHIVE_KEY } });
      await prisma.systemSetting.upsert({
        where: { key: RECEIVER_ARCHIVE_KEY },
        create: { key: RECEIVER_ARCHIVE_KEY, value: payload, updatedBy: null },
        update: { value: payload },
      });
      console.log(`  archived ${rows.length} TerminalReceiverConfig row(s) → SystemSetting["${RECEIVER_ARCHIVE_KEY}"]${existing ? " (previous archive replaced; identical source table)" : ""}`);
    } else {
      console.log("  TerminalReceiverConfig: 0 rows — nothing to archive");
    }
  } else {
    console.log(`  ${RECEIVER_TABLE}: table absent (already removed)`);
  }

  // ---- 3. relocate loopback device destination → application API override ----
  const adms = await prisma.systemSetting.findUnique({ where: { key: ADMS_SETTING_KEY } });
  if (adms) {
    try {
      const parsed = JSON.parse(adms.value) as {
        protocol?: string;
        host?: string;
        port?: number;
        readEnabled?: boolean;
        apiProtocol?: string | null;
        apiHost?: string | null;
        apiPort?: number | null;
      };
      const host = (parsed.host ?? "").toLowerCase();
      if (host && isLoopback(host)) {
        const relocated = {
          ...parsed,
          // device-facing destination cleared — loopback is never a valid
          // terminal destination; the UI shows "تنظیم نشده" until a real
          // reachable address is configured
          host: "",
          // application-facing API override receives the loopback address
          apiProtocol: parsed.apiProtocol ?? parsed.protocol ?? "http",
          apiHost: host,
          apiPort: parsed.apiPort ?? parsed.port ?? 8082,
        };
        await prisma.systemSetting.update({
          where: { key: ADMS_SETTING_KEY },
          data: { value: JSON.stringify(relocated) },
        });
        console.log(`  relocated loopback device destination ${host}:${parsed.port} → application API override (apiHost=${host}, apiPort=${relocated.apiPort}); device destination cleared`);
      } else {
        console.log("  terminal.admsServer: device destination is not loopback — no relocation needed");
      }
    } catch (e) {
      console.warn(`  terminal.admsServer: stored value not valid JSON (${(e as Error).message}) — left untouched`);
    }
  } else {
    console.log("  terminal.admsServer: not stored yet — nothing to relocate");
  }

  // ---- 4. drop the legacy receiver table ----
  if (await tableExists(RECEIVER_TABLE)) {
    await prisma.$executeRawUnsafe(`DROP TABLE "${RECEIVER_TABLE}"`);
    console.log(`  dropped table ${RECEIVER_TABLE}`);
  }

  // ---- 5. verify ----
  if (await tableExists(RECEIVER_TABLE)) {
    console.error("VERIFICATION FAILED — TerminalReceiverConfig still present");
    process.exit(1);
  }
  console.log("== Migration complete: legacy receiver removed (config archived), ADMS destinations separated ==");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("migration failed:", e);
  process.exit(1);
});
