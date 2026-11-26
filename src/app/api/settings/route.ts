import { z } from "zod";
import { db } from "@/lib/db";
import { fail, handleApiError, ok, readJson, requireUser } from "@/lib/api";
import { SETTING_KEYS, SETTING_LABELS, getAutomationSettings, invalidateSettingsCache } from "@/lib/settings";
import { logAudit } from "@/lib/auth";

/**
 * GET /api/settings — automation configuration (ADMIN only).
 * Returns effective values (defaults merged with stored overrides) so the
 * UI always displays the CURRENT behavior.
 */
export async function GET() {
  try {
    const auth = await requireUser(["ADMIN"]);
    if (auth.response) return auth.response;
    const settings = await getAutomationSettings();
    const rows = await db.systemSetting.findMany();
    const overridden = new Set(rows.map((r) => r.key));
    const items = Object.values(SETTING_KEYS).map((key) => ({
      key,
      label: SETTING_LABELS[key] ?? key,
      value: (settings as unknown as Record<string, unknown>)[key],
      overridden: overridden.has(key),
    }));
    return ok({ settings, items });
  } catch (e) {
    return handleApiError(e);
  }
}

const updateSchema = z.object({
  values: z
    .array(
      z.object({
        key: z.string().min(1),
        value: z.string().max(200).nullable(),
      })
    )
    .min(1, "هیچ تغییری ارسال نشده است."),
});

/**
 * PUT /api/settings — update automation parameters (ADMIN only).
 * Validated server-side: prefixes must be safe ASCII tokens; thresholds
 * bounded; sequences can never be set to collide (prefix + counter are
 * always combined with an existence check at allocation time).
 */
export async function PUT(request: Request) {
  try {
    const auth = await requireUser(["ADMIN"]);
    if (auth.response) return auth.response;
    const parsed = await readJson(request, updateSchema);
    if (parsed.response) return parsed.response;
    const { values } = parsed.data;

    const validKeys = new Set<string>(Object.values(SETTING_KEYS));
    const prefixRe = /^[A-Za-z0-9-]{1,20}$/;

    for (const { key, value } of values) {
      if (!validKeys.has(key)) return fail("تنظیم نامعتبر است.", 400);
      const v = (value ?? "").trim();
      switch (key) {
        case SETTING_KEYS.importerPrefix:
        case SETTING_KEYS.cardPrefix:
        case SETTING_KEYS.groupPrefix:
        case SETTING_KEYS.itemPrefix:
        case SETTING_KEYS.uomPrefix:
        case SETTING_KEYS.checkpointPrefix:
          if (!prefixRe.test(v)) {
            return fail("پیشوند باید فقط حروف انگلیسی، عدد یا خط تیره باشد (حداکثر ۲۰ حرف).", 400);
          }
          break;
        case SETTING_KEYS.quotaAlertThresholdPercent: {
          const n = Number(v);
          if (!Number.isFinite(n) || n < 1 || n > 100) {
            return fail("آستانه هشدار سهمیه باید عددی بین ۱ تا ۱۰۰ باشد.", 400);
          }
          break;
        }
        case SETTING_KEYS.duplicateWindowMinutes: {
          const n = Number(v);
          if (!Number.isFinite(n) || n < 0 || n > 1440) {
            return fail("پنجره هشدار ثبت تکراری باید عددی بین ۰ تا ۱۴۴۰ دقیقه باشد.", 400);
          }
          break;
        }
        case SETTING_KEYS.defaultWorkingPortId: {
          const n = Number(v);
          if (v !== "" && v !== "0" && (!Number.isFinite(n) || n < 0)) {
            return fail("مقدار بندر پیش‌فرض نامعتبر است.", 400);
          }
          if (Number.isFinite(n) && n > 0) {
            const cp = await db.borderCheckpoint.findUnique({ where: { id: Math.round(n) } });
            if (!cp) return fail("بندر انتخاب‌شده موجود نیست.", 400);
          }
          break;
        }
      }
    }

    const applied: { key: string; value: string }[] = [];
    const PREFIX_KEYS = [
      SETTING_KEYS.importerPrefix,
      SETTING_KEYS.cardPrefix,
      SETTING_KEYS.groupPrefix,
      SETTING_KEYS.itemPrefix,
      SETTING_KEYS.uomPrefix,
      SETTING_KEYS.checkpointPrefix,
    ] as string[];
    for (const { key, value } of values) {
      let v = (value ?? "").trim();
      if (PREFIX_KEYS.includes(key)) {
        v = v.toUpperCase();
      }
      await db.systemSetting.upsert({
        where: { key },
        create: { key, value: v, updatedBy: auth.user.id },
        update: { value: v, updatedBy: auth.user.id },
      });
      applied.push({ key, value: v });
    }

    invalidateSettingsCache();
    await logAudit(auth.user.id, "UPDATE", "SYSTEM_SETTING", null, null, applied);
    const settings = await getAutomationSettings();
    return ok({ settings });
  } catch (e) {
    return handleApiError(e);
  }
}
