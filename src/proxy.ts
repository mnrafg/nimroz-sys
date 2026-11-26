import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

/**
 * Defense-in-depth auth gate (V15 fix) — Next.js 16 "proxy" convention.
 *
 * Every API route already performs its own session + role + port-scope
 * check via `requireUser()`; this proxy guarantees that a FUTURE
 * route which forgets its guard cannot silently become public. The
 * /api/biometric/card-verify endpoint is intentionally public (QR
 * verifier target) and /api/auth/login must be reachable
 * pre-authentication; both are excluded.
 *
 * The secret is resolved lazily so the edge runtime never touches fs.
 */
let secretKey: Uint8Array | null = null;

async function getSecret(): Promise<Uint8Array | null> {
  if (secretKey) return secretKey;
  // In-process memo of the environment secret. When AUTH_SECRET is not
  // set, the Node runtime derives a persisted random secret — middleware
  // then stays in "presence check" mode and route-level guards remain
  // the authoritative layer (no false positives, no weakened checks).
  const envSecret = process.env.AUTH_SECRET?.trim();
  if (!envSecret || envSecret.length < 24) return null;
  secretKey = new TextEncoder().encode(envSecret);
  return secretKey;
}

const PUBLIC_API_PATHS = [
  "/api/auth/login",
  "/api/biometric/card-verify",
];

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF defence (V16.1 fix).
 *
 * The first version compared Origin against the Host header, but that
 * falsely rejected legitimate users here: the public preview/proxy chain
 * rewrites the Host header before it reaches the app, so Origin and Host
 * can never match. We now use the Fetch-metadata `Sec-Fetch-Site` header
 * instead — it is set by the BROWSER itself (per the Fetch spec it cannot
 * be forged by page JavaScript) and is completely independent of proxy
 * header rewriting:
 *   - `cross-site`  → CSRF attempt, rejected
 *   - `same-origin` / `same-site` / `none` → legitimate, allowed
 *   - header absent → non-browser client (curl, Windows gateway) or a very
 *     old browser; allowed, because cookie attacks are already blocked by
 *     the SameSite=Strict session cookie.
 */
function isCrossSiteBrowserRequest(request: NextRequest): boolean {
  return request.headers.get("sec-fetch-site") === "cross-site";
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!pathname.startsWith("/api/")) return NextResponse.next();

  // CSRF check runs BEFORE the public-path shortcut so that it also
  // protects /api/auth/login (login-CSRF).
  if (MUTATING_METHODS.has(request.method) && isCrossSiteBrowserRequest(request)) {
    return NextResponse.json(
      { error: "درخواست از مبدأ نامعتبر رد شد." },
      { status: 403 }
    );
  }

  if (PUBLIC_API_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  const token = request.cookies.get("aogc_session")?.value;
  if (!token) {
    return NextResponse.json(
      { error: "نشست شما منقضی شده است. لطفاً دوباره وارد سیستم شوید." },
      { status: 401 }
    );
  }

  const secret = await getSecret();
  if (secret) {
    try {
      await jwtVerify(token, secret);
    } catch {
      return NextResponse.json(
        { error: "نشست شما منقضی شده است. لطفاً دوباره وارد سیستم شوید." },
        { status: 401 }
      );
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};
