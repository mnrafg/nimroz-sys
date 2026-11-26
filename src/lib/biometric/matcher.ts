import "server-only";
import { createHmac, timingSafeEqual } from "crypto";
import { getAuthSecret } from "@/lib/secret";

// ============================================================
// Server-side 1:N matcher — capability-gated.
//
// The identification (Mode B) workflow requires a reliable 1:N matcher.
// Until the exact ZKTeco SDK model is confirmed and its server-side
// matching engine is available, this component reports
// `serverMatchingSupported === false` and the identify API answers with
// a clear limitation message. NO simulated matching is performed —
// an unknown fingerprint is never silently "matched".
// ============================================================

export interface MatchCandidate {
  fingerprintId: number;
  importerId: number;
  /** decrypted template base64 */
  templateBase64: string;
}

export interface MatchResult {
  matched: boolean;
  importerId?: number;
  fingerprintId?: number;
  score?: number;
}

export interface ServerMatcher {
  readonly name: string;
  /** true when a real SDK-backed matching engine is installed */
  readonly supported: boolean;
  match(probe: string, candidates: MatchCandidate[], minScore: number): Promise<MatchResult>;
}

class UnsupportedMatcher implements ServerMatcher {
  readonly name = "unsupported";
  readonly supported = false;
  async match(): Promise<MatchResult> {
    // Never fabricate a result.
    return { matched: false };
  }
}

export const serverMatcher: ServerMatcher = new UnsupportedMatcher();

export function isServerMatchingSupported(): boolean {
  return serverMatcher.supported;
}

// ============================================================
// Card verification token — opaque & revocable.
// The QR code never contains Tazkira numbers, biometric templates or
// other sensitive data — only a signed, non-reversible identifier that
// the verification endpoint can validate and that becomes invalid as
// soon as the importer/card is deactivated.
// ============================================================

export function cardToken(cardNumber: string): string {
  const sig = createHmac("sha256", hmacSecret())
    .update(`card-verify::${cardNumber}`)
    .digest("hex")
    .slice(0, 24);
  return Buffer.from(`${cardNumber}.${sig}`, "utf8").toString("base64url");
}

export function parseCardToken(token: string): string | null {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const idx = decoded.lastIndexOf(".");
    if (idx <= 0) return null;
    const cardNumber = decoded.slice(0, idx);
    const sig = decoded.slice(idx + 1);
    const expected = createHmac("sha256", hmacSecret())
      .update(`card-verify::${cardNumber}`)
      .digest("hex")
      .slice(0, 24);
    const a = Buffer.from(sig, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return cardNumber;
  } catch {
    return null;
  }
}

function hmacSecret(): string {
  return getAuthSecret();
}
