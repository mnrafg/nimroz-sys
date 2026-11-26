// ============================================================
// Text / digit normalization for duplicate checks and search.
// Pure functions — safe on server and client.
//
// Arabic, Persian and Latin digit variants are unified for
// SEARCHING and VALIDATION while original identity documents
// (Tazkira numbers, licenses …) are always stored as entered.
// ============================================================

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

/** Persian ۰-۹ and Arabic ٠-٩ → Latin 0-9. */
export function normalizeDigits(s: string | null | undefined): string {
  if (!s) return "";
  return String(s)
    .replace(/[۰-۹]/g, (c) => String(PERSIAN_DIGITS.indexOf(c)))
    .replace(/[٠-٩]/g, (c) => String(ARABIC_DIGITS.indexOf(c)));
}

/**
 * Aggressive normalization for duplicate detection:
 *  - digit variants unified
 *  - Arabic/Persian letter variants unified (ي→ی, ك→ک, ة→ه, أ/إ/آ→ا)
 *  - tatweel/diacritics stripped
 *  - whitespace collapsed
 */
export function normalizeText(s: string | null | undefined): string {
  if (!s) return "";
  return normalizeDigits(String(s))
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[يﻯﻰ]/g, "ی")
    .replace(/[ك]/g, "ک")
    .replace(/[ة]/g, "ه")
    .replace(/[أإآ]/g, "ا")
    .replace(/\s+/g, " ")
    .trim();
}

/** Digits-only key for identifier comparison (Tazkira, card, license …).
 *  Leading zeros are preserved meaningfully: both the exact normalized
 *  string and the zero-stripped variant can be compared by callers. */
export function normalizeIdentifier(s: string | null | undefined): string {
  return normalizeDigits(s).replace(/[\s\-_/\\.]/g, "").trim();
}

export function stripLeadingZeros(s: string): string {
  const t = s.replace(/^0+/, "");
  return t === "" ? "0" : t;
}
