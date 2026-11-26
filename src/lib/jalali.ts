import { toJalaali as j2j, toGregorian as j2g, isValidJalaaliDate, jalaaliMonthLength } from "jalaali-js";

// ============================================================
// Afghan Solar Hijri calendar + Asia/Kabul (UTC+04:30) helpers
// Pure functions — safe on both server and client.
// ============================================================

/** Asia/Kabul has a fixed offset of +04:30 (no DST). */
export const KABUL_OFFSET_MIN = 270;

export const JALALI_MONTHS = [
  "حمل",
  "ثور",
  "جوزا",
  "سرطان",
  "اسد",
  "سنبله",
  "میزان",
  "عقرب",
  "قوس",
  "جدی",
  "دلو",
  "حوت",
];

/** Indexed by JS getUTCDay(): 0 = Sunday ... 6 = Saturday */
export const WEEK_DAYS_FA = [
  "یکشنبه",
  "دوشنبه",
  "سه‌شنبه",
  "چهارشنبه",
  "پنجشنبه",
  "جمعه",
  "شنبه",
];

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

export function toPersianDigits(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return "—";
  return String(s).replace(/[0-9]/g, (c) => PERSIAN_DIGITS[Number(c)]);
}

export function toLatinDigits(s: string): string {
  return String(s)
    .replace(/[۰-۹]/g, (c) => String(PERSIAN_DIGITS.indexOf(c)))
    .replace(/[٠-٩]/g, (c) => String("٠١٢٣٤٥٦٧٨٩".indexOf(c)));
}

export interface KabulParts {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
  sec: number;
  dow: number; // 0 = Sunday ... 6 = Saturday
}

/** Shift a UTC instant into "Kabul wall-clock" readable via UTC getters. */
export function kabulShift(date: Date): Date {
  return new Date(date.getTime() + KABUL_OFFSET_MIN * 60000);
}

export function kabulParts(date: Date): KabulParts {
  const s = kabulShift(date);
  return {
    y: s.getUTCFullYear(),
    m: s.getUTCMonth() + 1,
    d: s.getUTCDate(),
    h: s.getUTCHours(),
    min: s.getUTCMinutes(),
    sec: s.getUTCSeconds(),
    dow: s.getUTCDay(),
  };
}

/** Build a UTC instant from a Kabul wall-clock date/time. */
export function kabulDateToUtc(
  y: number,
  m: number,
  d: number,
  h = 0,
  min = 0,
  sec = 0
): Date {
  return new Date(Date.UTC(y, m - 1, d, h, min, sec) - KABUL_OFFSET_MIN * 60000);
}

export interface JalaliDate {
  jy: number;
  jm: number;
  jd: number;
}

export function toJalali(date: Date): JalaliDate {
  const p = kabulParts(date);
  return j2j(p.y, p.m, p.d);
}

export function jalaliToUtc(jy: number, jm: number, jd: number, h = 0, min = 0): Date {
  const g = j2g(jy, jm, jd);
  return kabulDateToUtc(g.gy, g.gm, g.gd, h, min);
}

export function isValidJalali(jy: number, jm: number, jd: number): boolean {
  return isValidJalaaliDate(jy, jm, jd);
}

export function jalaliMonthLength(jy: number, jm: number): number {
  return jalaaliMonthLength(jy, jm);
}

/** Safe variant for calendar UI rendering (never throws). */
export function jalaaliMonthLengthSafe(jy: number, jm: number): number {
  try {
    if (!isValidJalaaliDate(jy, jm, 1)) return 30;
    return jalaaliMonthLength(jy, jm);
  } catch {
    return 30;
  }
}

/** Parse "1404/07/15" (Persian or Latin digits, / or - separators). */
export function parseJalaliString(s: string): JalaliDate | null {
  const t = toLatinDigits(String(s).trim()).replace(/[\-\.]/g, "/");
  const m = t.match(/^(\d{3,4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  const jy = Number(m[1]);
  const jm = Number(m[2]);
  const jd = Number(m[3]);
  if (!isValidJalali(jy, jm, jd)) return null;
  return { jy, jm, jd };
}

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** Format number with Persian digits and Afghan-style grouping. */
export function formatNumber(n: number | null | undefined, maxFrac = 3): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const fixed = trimZeros(Math.abs(n).toFixed(maxFrac));
  const [int, frac] = fixed.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, "،");
  const sign = n < 0 ? "-" : "";
  return toPersianDigits(sign + (frac ? `${grouped}.${frac}` : grouped));
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Normalize display dates, including server telemetry in epoch milliseconds. */
function displayDate(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (!(value instanceof Date) && typeof value !== "string" && typeof value !== "number") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** ۱۴۰۴/۰۷/۱۵ or ۱۵ میزان ۱۴۰۴ */
export function formatJalali(
  date: Date | string | number | null | undefined,
  opts?: { monthName?: boolean; weekday?: boolean }
): string {
  const d = displayDate(date);
  if (!d) return "—";
  const { jy, jm, jd } = toJalali(d);
  const base = opts?.monthName
    ? `${toPersianDigits(jd)} ${JALALI_MONTHS[jm - 1]} ${toPersianDigits(jy)}`
    : toPersianDigits(`${jy}/${pad2(jm)}/${pad2(jd)}`);
  if (opts?.weekday) {
    const dow = kabulParts(d).dow;
    return `${WEEK_DAYS_FA[dow]} ${base}`;
  }
  return base;
}

/**
 * ۰۸:۳۰ ق.ظ / ۰۱:۴۵ ب.ظ — 12-hour clock with Afghan Dari AM/PM indicators.
 * Database timestamps and quota windows are untouched; presentation only.
 */
export function formatTime(date: Date | string | number | null | undefined): string {
  const d = displayDate(date);
  if (!d) return "—";
  const p = kabulParts(d);
  const period = p.h < 12 ? "ق.ظ" : "ب.ظ";
  let h12 = p.h % 12;
  if (h12 === 0) h12 = 12;
  return `${toPersianDigits(`${pad2(h12)}:${pad2(p.min)}`)} ${period}`;
}

/** ۱۴:۳۰ — 24-hour variant kept for chart tooltips and technical labels. */
export function formatTime24(date: Date | string | number | null | undefined): string {
  const d = displayDate(date);
  if (!d) return "—";
  const p = kabulParts(d);
  return toPersianDigits(`${pad2(p.h)}:${pad2(p.min)}`);
}

/** ۱۴۰۴/۰۷/۱۵ ساعت ۰۸:۳۰ ق.ظ */
export function formatJalaliDateTime(date: Date | string | number | null | undefined): string {
  const d = displayDate(date);
  if (!d) return "—";
  return `${formatJalali(d)} ساعت ${formatTime(d)}`;
}

export function startOfTodayKabul(): Date {
  const p = kabulParts(new Date());
  return kabulDateToUtc(p.y, p.m, p.d);
}

export function nowKabulParts(): KabulParts {
  return kabulParts(new Date());
}

// ============================================================
// Quota period windows (business rules run on Asia/Kabul)
// ============================================================

export type PeriodType = "DAILY" | "WEEKLY" | "MONTHLY" | "TOTAL";

export interface PeriodWindow {
  from: Date;
  to: Date; // exclusive upper bound
  label: string;
}

/**
 * Compute the aggregation window for a quota period containing `date`.
 * Weekly periods follow the Afghan week (Saturday → Friday).
 * Monthly periods follow the Solar Hijri month.
 */
export function periodWindowFor(periodType: PeriodType, date: Date): PeriodWindow {
  const p = kabulParts(date);
  const { jy, jm, jd } = j2j(p.y, p.m, p.d);

  if (periodType === "DAILY") {
    const from = kabulDateToUtc(p.y, p.m, p.d);
    const to = kabulDateToUtc(p.y, p.m, p.d + 1);
    return {
      from,
      to,
      label: `${formatJalali(date, { weekday: true })} (روزانه)`,
    };
  }

  if (periodType === "WEEKLY") {
    // Afghan week starts on Saturday (dow 6). Days since Saturday:
    const daysSinceSat = (p.dow + 1) % 7;
    const from = kabulDateToUtc(p.y, p.m, p.d - daysSinceSat);
    const to = kabulDateToUtc(p.y, p.m, p.d - daysSinceSat + 7);
    const jFrom = toJalali(from);
    const jTo = toJalali(new Date(to.getTime() - 60000));
    return {
      from,
      to,
      label: `هفته ${toPersianDigits(jFrom.jd)} ${JALALI_MONTHS[jFrom.jm - 1]} تا ${toPersianDigits(jTo.jd)} ${JALALI_MONTHS[jTo.jm - 1]} ${toPersianDigits(jFrom.jy)}`,
    };
  }

  if (periodType === "MONTHLY") {
    const gFrom = j2g(jy, jm, 1);
    const njy = jm === 12 ? jy + 1 : jy;
    const njm = jm === 12 ? 1 : jm + 1;
    const gTo = j2g(njy, njm, 1);
    const from = kabulDateToUtc(gFrom.gy, gFrom.gm, gFrom.gd);
    const to = kabulDateToUtc(gTo.gy, gTo.gm, gTo.gd);
    return {
      from,
      to,
      label: `${JALALI_MONTHS[jm - 1]} ${toPersianDigits(jy)} (ماهانه)`,
    };
  }

  // TOTAL — caller must supply the limit's own effective range.
  const from = kabulDateToUtc(p.y, p.m, p.d);
  const to = kabulDateToUtc(p.y, p.m, p.d + 1);
  return { from, to, label: "کلی (مجموعی)" };
}
