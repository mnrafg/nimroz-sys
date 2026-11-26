/**
 * Seed script — AOGC Border Import Control System
 *
 * MINIMAL PRODUCTION SEED + SAMPLE WORKING DATA — idempotent (safe to re-run).
 *
 * Core (system essentials, inserted only when missing):
 *   1. Roles (ADMIN, OFFICER)
 *   2. One administrator account
 *   3. The border port بندر نیمروز (Nimroz)
 *   4. The unit of measure لیتر (Liter)
 *   5. Default working port = Nimroz
 *
 * Sample working data (inserted only while NO importer exists — so it never
 * mixes with real production records; delete these records via the UI once
 * real registration starts):
 *   - 1 item category + 2 items (پطرول ۹۲ / تیل دیزل — base unit لیتر)
 *   - 2 border-worker importers registered at نیمروز
 *   - 1 group (گروپ) whose representative is flagged importer IMP-001
 *   - سهمیه بندی: 1 individual quota + 1 group quota (monthly, لیتر, نیمروز)
 *   - واردات: 1 approved entry + 1 draft entry (لیتر, نیمروز)
 *
 * Run: bun run db:seed
 * Set SEED_ADMIN_PASSWORD when creating the first administrator.
 * SEED_ADMIN_EMAIL defaults to admin@localhost. Existing credentials are preserved.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { toJalali, jalaliToUtc, kabulDateToUtc, kabulParts, formatJalali } from "../src/lib/jalali";

const db = new PrismaClient();

async function main() {
  const now = new Date();
  const adminEmail = (process.env.SEED_ADMIN_EMAIL ?? "admin@localhost").trim().toLowerCase();
  if (!adminEmail || adminEmail.length > 191) {
    throw new Error("SEED_ADMIN_EMAIL must contain between 1 and 191 characters.");
  }
  let admin = await db.user.findUnique({ where: { email: adminEmail } });
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!admin && (!adminPassword || adminPassword.length < 8 || Buffer.byteLength(adminPassword, "utf8") > 72)) {
    throw new Error("Set SEED_ADMIN_PASSWORD to 8 or more characters (at most 72 UTF-8 bytes) before creating the administrator.");
  }

  // ---------- Core: roles ----------
  let roleAdmin = await db.role.findUnique({ where: { name: "ADMIN" } });
  if (!roleAdmin) {
    roleAdmin = await db.role.create({
      data: { name: "ADMIN", nameDari: "مدیر سیستم", description: "دسترسی کامل به تمام بخش‌های سیستم" },
    });
  }

  // ---------- Core: border port Nimroz (بندر نیمروز) ----------
  let nimroz = await db.borderCheckpoint.findUnique({ where: { code: "NMZ" } });
  if (!nimroz) {
    nimroz = await db.borderCheckpoint.create({
      data: { code: "NMZ", name: "نیمروز", province: "نیمروز" },
    });
  }

  // ---------- Core: UOM Liter (لیتر) ----------
  let uomLtr = await db.uom.findUnique({ where: { code: "LTR" } });
  if (!uomLtr) {
    uomLtr = await db.uom.create({ data: { code: "LTR", name: "لیتر", symbol: "ل" } });
  }

  // ---------- Core: administrator ----------
  if (!admin) {
    admin = await db.user.create({
      data: {
        name: "مدیر سیستم AOGC",
        email: adminEmail,
        passwordHash: bcrypt.hashSync(adminPassword!, 10),
        passwordChangedAt: now,
        roleId: roleAdmin.id,
      },
    });
  }

  // ---------- Core: default working port → Nimroz ----------
  const portSetting = await db.systemSetting.findUnique({ where: { key: "defaults.workingPortId" } });
  if (!portSetting) {
    await db.systemSetting.create({
      data: { key: "defaults.workingPortId", value: String(nimroz.id), updatedBy: admin.id },
    });
  }

  // ---------- Audit trail (first seed only) ----------
  const seedLogged = await db.auditLog.findFirst({ where: { action: "SEED" } });
  if (!seedLogged) {
    await db.auditLog.create({
      data: {
        userId: admin.id,
        action: "SEED",
        recordType: "SYSTEM",
        recordId: null,
        newValues: JSON.stringify({
          seededAt: now.toISOString(),
          date: formatJalali(now),
          scope: "minimal-production",
          checkpoint: nimroz.name,
          uom: "لیتر",
        }),
      },
    });
  }

  
  // =====================================================================
  // SAMPLE WORKING DATA — only while the system has NO importers yet.
  // =====================================================================
  
 
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
