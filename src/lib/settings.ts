import { db } from "@/lib/db";

/**
 * Administrator-configurable automation parameters.
 *
 * Values are read through `getAutomationSettings()` with a short in-memory
 * cache (60s) so request paths never hit the settings table on every call.
 * Built-in defaults are used for any missing/invalid key.
 */
export const SETTING_KEYS = {
  importerPrefix: "numbering.importerPrefix",
  cardPrefix: "numbering.cardPrefix",
  groupPrefix: "numbering.groupPrefix",
  itemPrefix: "numbering.itemPrefix",
  uomPrefix: "numbering.uomPrefix",
  checkpointPrefix: "numbering.checkpointPrefix",
  quotaAlertThresholdPercent: "alerts.quotaAlertThresholdPercent",
  duplicateWindowMinutes: "alerts.duplicateWindowMinutes",
  defaultWorkingPortId: "defaults.workingPortId",
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

export const SETTING_LABELS: Record<string, string> = {
  [SETTING_KEYS.importerPrefix]: "پیشوند نمبر واردکننده",
  [SETTING_KEYS.cardPrefix]: "پیشوند شماره کارت شناسایی",
  [SETTING_KEYS.groupPrefix]: "پیشوند کود گروپ",
  [SETTING_KEYS.itemPrefix]: "پیشوند کود داخلی جنس",
  [SETTING_KEYS.uomPrefix]: "پیشوند کود داخلی واحد",
  [SETTING_KEYS.checkpointPrefix]: "پیشوند کود داخلی بندر",
  [SETTING_KEYS.quotaAlertThresholdPercent]: "آستانه هشدار سهمیه (درصد)",
  [SETTING_KEYS.duplicateWindowMinutes]: "پنجره هشدار ثبت تکراری (دقیقه)",
  [SETTING_KEYS.defaultWorkingPortId]: "بندر پیش‌فرض کار (مدیر ملی — ۰ = بدون انتخاب)",
};

export interface AutomationSettings {
  importerPrefix: string;
  cardPrefix: string;
  groupPrefix: string;
  itemPrefix: string;
  uomPrefix: string;
  checkpointPrefix: string;
  quotaAlertThresholdPercent: number;
  duplicateWindowMinutes: number;
  defaultWorkingPortId: number | null;
}

const DEFAULTS: AutomationSettings = {
  importerPrefix: "IMP-",
  cardPrefix: "AOGC-IC-",
  groupPrefix: "GRP-",
  itemPrefix: "ITM-",
  uomPrefix: "UOM-",
  checkpointPrefix: "CHP-",
  quotaAlertThresholdPercent: 80,
  duplicateWindowMinutes: 30,
  defaultWorkingPortId: null,
};

const PREFIX_RE = /^[A-Za-z0-9-]{1,20}$/;

let cache: { data: AutomationSettings; at: number } | null = null;
const CACHE_MS = 60_000;

export function invalidateSettingsCache() {
  cache = null;
}

export async function getAutomationSettings(): Promise<AutomationSettings> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  let data: AutomationSettings = { ...DEFAULTS };
  try {
    const rows = await db.systemSetting.findMany();
    for (const row of rows) {
      switch (row.key) {
        case SETTING_KEYS.importerPrefix:
        case SETTING_KEYS.cardPrefix:
        case SETTING_KEYS.groupPrefix:
        case SETTING_KEYS.itemPrefix:
        case SETTING_KEYS.uomPrefix:
        case SETTING_KEYS.checkpointPrefix:
          if (PREFIX_RE.test(row.value)) {
            (data as unknown as Record<string, unknown>)[row.key] = row.value.toUpperCase();
          }
          break;
        case SETTING_KEYS.quotaAlertThresholdPercent: {
          const n = Number(row.value);
          if (Number.isFinite(n) && n >= 1 && n <= 100) {
            data.quotaAlertThresholdPercent = Math.round(n);
          }
          break;
        }
        case SETTING_KEYS.duplicateWindowMinutes: {
          const n = Number(row.value);
          if (Number.isFinite(n) && n >= 0 && n <= 24 * 60) {
            data.duplicateWindowMinutes = Math.round(n);
          }
          break;
        }
        case SETTING_KEYS.defaultWorkingPortId: {
          const n = Number(row.value);
          if (Number.isFinite(n) && n > 0) data.defaultWorkingPortId = Math.round(n);
          break;
        }
      }
    }
  } catch {
    // Settings table unavailable — defaults still guarantee operation.
  }
  cache = { data, at: Date.now() };
  return data;
}
