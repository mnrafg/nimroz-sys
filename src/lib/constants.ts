// ============================================================
// Dari (Afghanistan) labels and shared constants
// ============================================================

// Only TWO roles exist: Admin and Officer (legacy supervisor accounts
// were migrated to Officer; the key is kept out of new business logic).
export const ROLE = {
  ADMIN: "ADMIN",
  OFFICER: "OFFICER",
} as const;

export type RoleName = (typeof ROLE)[keyof typeof ROLE];

export const ROLE_LABELS: Record<string, string> = {
  ADMIN: "مدیر سیستم",
  OFFICER: "کارمند ثبت واردات",
  // Legacy label retained ONLY so historical audit rows render correctly.
  SUPERVISOR: "آمر / مسئول (سابقه — اکنون کارمند ثبت واردات)",
};

export const ENTRY_STATUS = {
  DRAFT: "DRAFT",
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  REVERSED: "REVERSED",
} as const;

export const ENTRY_STATUS_LABELS: Record<string, string> = {
  DRAFT: "مسوده",
  PENDING: "در انتظار تأیید (سابقه)",
  APPROVED: "ثبت‌شده",
  REJECTED: "ردشده (سابقه)",
  REVERSED: "ابطال‌شده",
};

export const EXCEPTION_STATUS_LABELS: Record<string, string> = {
  PENDING: "در انتظار تصمیم",
  APPROVED: "تأییدشده",
  REJECTED: "ردشده",
};

export const PERIOD_LABELS: Record<string, string> = {
  DAILY: "روزانه",
  WEEKLY: "هفتگی",
  MONTHLY: "ماهانه",
  TOTAL: "کلی (مجموعی)",
};

export const ACTION_LABELS: Record<string, string> = {
  CREATE: "ایجاد",
  SUBMIT: "ثبت نهایی",
  FINALIZE: "ثبت نهایی",
  APPROVE: "تأیید",
  REJECT: "رد",
  EXCEPTION_REQUEST: "ثبت بیش از حد",
  EXCEPTION_APPROVE: "تأیید استثنا",
  EXCEPTION_REJECT: "رد استثنا",
  REVERSE: "ابطال",
  LOGIN: "ورود به سیستم",
  LOGOUT: "خروج از سیستم",
  // Biometric actions
  BIOMETRIC_ENROLL: "ثبت اثر انگشت",
  BIOMETRIC_REPLACE: "تعویض اثر انگشت",
  BIOMETRIC_REVOKE: "ابطال اثر انگشت",
  BIOMETRIC_VERIFY_PREPARE: "آغاز تأیید بایومتریک",
  BIOMETRIC_VERIFY_SUCCESS: "تأیید موفق اثر انگشت",
  BIOMETRIC_VERIFY_FAIL: "تأیید ناموفق اثر انگشت",
  BIOMETRIC_IDENTIFY_ATTEMPT: "تلاش شناسایی اثر انگشت",
  BIOMETRIC_IDENTIFY_MATCH: "شناسایی موفق اثر انگشت",
  CARD_PRINT: "چاپ کارت شناسایی",
};

export const RECORD_TYPE_LABELS: Record<string, string> = {
  USER: "کاربر",
  ROLE: "صلاحیت",
  IMPORTER: "واردکننده",
  ITEM: "جنس",
  ITEM_CATEGORY: "دسته جنس",
  UOM: "واحد اندازه‌گیری",
  UOM_CONVERSION: "تبدیل واحد",
  CHECKPOINT: "بندر",
  IMPORT_LIMIT: "حد مجاز واردات",
  IMPORT_ENTRY: "ثبت واردات",
  IMPORT_ENTRY_ITEM: "قلم ثبت واردات",
  IMPORTER_FINGERPRINT: "اثر انگشت واردکننده",
};

export const STATUS_LABELS: Record<string, string> = {
  ACTIVE: "فعال",
  INACTIVE: "غیرفعال",
};

export const REPORT_TYPE_LABELS: Record<string, string> = {
  daily: "گزارش واردات روزانه",
  monthly: "گزارش واردات ماهانه",
  importer: "گزارش به اساس واردکننده",
  item: "گزارش به اساس جنس",
  checkpoint: "گزارش به اساس بندر",
  remaining_quota: "گزارش حد باقی‌مانده",
  exception: "گزارش استثناهای ثبت‌شده (سابقه — دیگر ثبت نمی‌شود)",
};

export const APP_NAME = "سیستم کنترل واردات مرزی";
export const ORG_NAME = "شرکت نفت و گاز افغانستان";
export const ORG_SHORT = "AOGC";

// ============================================================
// Standardized Afghan provinces (ولایات افغانستان — ۳۴ ولایت).
// Used by the checkpoint form and importer registration so province
// names are always consistent (no free-text spellings).
// ============================================================

export const AFGHAN_PROVINCES: string[] = [
  "بدخشان",
  "بادغیس",
  "بغلان",
  "بلخ",
  "بامیان",
  "دایکندی",
  "فاریاب",
  "غزنی",
  "غور",
  "جوزجان",
  "هلمند",
  "هرات",
  "کابل",
  "کندهار",
  "کاپیسا",
  "کنر",
  "خوست",
  "کندز",
  "لغمان",
  "لوگر",
  "میدان وردک",
  "ننگرهار",
  "نیمروز",
  "نورستان",
  "پکتیا",
  "پکتیکا",
  "پنجشیر",
  "پروان",
  "سمنگان",
  "سرپل",
  "تخار",
  "ارزگان",
  "زابل",
  "فراه",
];
