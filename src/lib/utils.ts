import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const DIGIT_MAP: Record<string, string> = {
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
  "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
};

/**
 * Normalize Dari/Persian/Arabic + Latin text for forgiving search matching.
 * Unifies ی/ي, ک/ك, ه variants, strips diacritics and maps Arabic-Indic
 * digits to Latin so mixed-script queries still match.
 */
export function normalizeSearchText(input: string): string {
  const chars = Array.from(String(input).toLowerCase()).map((c) => DIGIT_MAP[c] ?? c);
  return chars
    .join("")
    .replace(/[\u064B-\u065F\u0670]/g, "") // diacritics
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/ة/g, "ه")
    .replace(/أ|إ|آ/g, "ا")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ی")
    .replace(/[\u200c\u200f\u200e]/g, " ") // ZWNJ / directional marks
    .replace(/\s+/g, " ")
    .trim();
}

/** True when every whitespace-separated term of the query matches the haystack. */
export function searchMatch(haystack: string, query: string): boolean {
  const norm = normalizeSearchText(query);
  if (!norm) return true;
  const target = normalizeSearchText(haystack);
  const compact = target.replace(/\s+/g, "");
  return norm.split(" ").every((t) => target.includes(t) || compact.includes(t));
}

/** Locale-aware comparison that works for Dari text and numeric strings. */
export function compareValues(a: string | number | null, b: string | number | null): number {
  if (a === null) return b === null ? 0 : -1;
  if (b === null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "fa", { numeric: true, sensitivity: "base" });
}
