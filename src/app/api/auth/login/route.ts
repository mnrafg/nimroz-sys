import { z } from "zod";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import { createSessionToken, logAudit, SESSION_COOKIE, verifyPassword } from "@/lib/auth";
import { fail, handleApiError, ok, readJson } from "@/lib/api";
import { formatJalali } from "@/lib/jalali";

const loginSchema = z.object({
  email: z.string().trim().min(1, "لطفاً آدرس ایمیل را بنویسید.").max(254),
  // 128-char cap bounds the bcrypt work an attacker can trigger per request.
  password: z.string().min(1, "لطفاً پاسورد را بنویسید.").max(128),
});

// ============================================================
// Login throttling — three independent sliding windows
// (hardened version of the previous single email+IP bucket):
//   1. email+IP : 6 failures  -> 10 min lock   (single-target brute force)
//   2. IP       : 30 failures -> 15 min lock   (credential stuffing sweeps)
//   3. email    : 15 failures -> 15 min lock   (distributed attack on ONE account)
// Buckets are periodically swept so the maps cannot grow unbounded
// (memory-exhaustion guard) and are hard-cleared if an active flood
// pushes them past the cap.
// All lock messages are deliberately generic — the endpoint must not
// reveal whether an email exists, which layer tripped, or when exactly
// a lock will lift beyond the Retry-After seconds.
// ============================================================
const EMAIL_IP_MAX = 6;
const EMAIL_IP_LOCK_MS = 10 * 60 * 1000;
const IP_MAX = 30;
const IP_LOCK_MS = 15 * 60 * 1000;
const EMAIL_MAX = 15;
const EMAIL_LOCK_MS = 15 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const MAP_HARD_CAP = 20_000;
const OLDEST_KEEP_MS = Math.max(EMAIL_IP_LOCK_MS, IP_LOCK_MS, EMAIL_LOCK_MS);

interface AttemptRec {
  count: number;
  firstAt: number;
  lockedUntil: number;
}

const emailIpBuckets = new Map<string, AttemptRec>();
const ipBuckets = new Map<string, AttemptRec>();
const emailBuckets = new Map<string, AttemptRec>();
let lastSweep = 0;

function sweep(now: number) {
  for (const map of [emailIpBuckets, ipBuckets, emailBuckets]) {
    for (const [key, rec] of map) {
      if (rec.lockedUntil <= now && now - rec.firstAt > OLDEST_KEEP_MS) {
        map.delete(key);
      }
    }
  }
  lastSweep = now;
}

function maybeSweep(now: number) {
  const totalSize = emailIpBuckets.size + ipBuckets.size + emailBuckets.size;
  if (now - lastSweep > SWEEP_INTERVAL_MS || totalSize > MAP_HARD_CAP) {
    sweep(now);
    // Still overflowing after sweeping → an active flood is in progress;
    // fail closed (clear everything) rather than exhaust memory.
    if (emailIpBuckets.size + ipBuckets.size + emailBuckets.size > MAP_HARD_CAP) {
      emailIpBuckets.clear();
      ipBuckets.clear();
      emailBuckets.clear();
    }
  }
}

/** Registers a failure; returns true when this failure just engaged a lock. */
function registerFailure(map: Map<string, AttemptRec>, key: string, max: number, lockMs: number, now: number): boolean {
  const rec = map.get(key);
  if (!rec || now - rec.firstAt > lockMs) {
    map.set(key, { count: 1, firstAt: now, lockedUntil: 0 });
    return false;
  }
  rec.count += 1;
  if (rec.count >= max) {
    rec.lockedUntil = now + lockMs;
    rec.count = 0;
    rec.firstAt = now;
    return true;
  }
  return false;
}

/** Seconds remaining on a lock, or 0 when not locked. */
function lockedSeconds(map: Map<string, AttemptRec>, key: string, now: number): number {
  const rec = map.get(key);
  if (!rec || rec.lockedUntil <= now) return 0;
  return Math.ceil((rec.lockedUntil - now) / 1000);
}

function clearAll(email: string, ip: string, now: number) {
  emailIpBuckets.delete(`${email}|${ip}`);
  ipBuckets.delete(ip);
  emailBuckets.delete(email);
}

// ============================================================
// Client IP resolution — hardened against X-Forwarded-For spoofing.
// Caddy OVERWRITES X-Real-IP with the real peer address, while
// X-Forwarded-For only has the peer APPENDED (client-controlled
// prefix survives). Therefore X-Real-IP wins; XFF falls back to the
// LAST element (closest trusted proxy), never the first.
// ============================================================
function clientIp(request: Request): string {
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return "local";
}

// A precomputed bcrypt hash so a login attempt for a NON-EXISTENT email
// still runs one full bcrypt comparison — without it the fast response
// would let attackers enumerate valid emails by timing (response-time
// user enumeration). Seeded lazily once per process.
let dummyHash: string | null = null;
async function getDummyHash(): Promise<string> {
  if (!dummyHash) {
    dummyHash = await bcrypt.hash(randomBytes(24).toString("hex"), 10);
  }
  return dummyHash;
}

export async function POST(request: Request) {
  try {
    const parsed = await readJson(request, loginSchema);
    if (parsed.response) return parsed.response;
    const { email, password } = parsed.data;
    const normalizedEmail = email.trim().toLowerCase();
    const ip = clientIp(request);
    const userAgent = request.headers.get("user-agent")?.slice(0, 250) ?? "";
    const now = Date.now();
    maybeSweep(now);

    // Layer 1/2/3 locks — generic message + Retry-After.
    const remaining = Math.max(
      lockedSeconds(emailIpBuckets, `${normalizedEmail}|${ip}`, now),
      lockedSeconds(ipBuckets, ip, now),
      lockedSeconds(emailBuckets, normalizedEmail, now)
    );
    if (remaining > 0) {
      return fail(
        "به دلیل تلاش‌های ناموفق متعدد، دسترسی موقتاً محدود شده است؛ لطفاً چند دقیقه دیگر دوباره تلاش کنید.",
        429,
        { "Retry-After": String(Math.min(remaining, 900)) }
      );
    }

    const user = await db.user.findUnique({
      where: { email: normalizedEmail },
      include: { role: true, checkpoint: true },
    });

    // Password verification runs in BOTH branches (real hash or dummy hash)
    // so response timing does not leak account existence.
    const passwordOk = await verifyPassword(
      password,
      user ? user.passwordHash : await getDummyHash()
    );

    if (!user || !passwordOk) {
      const lockedEmailIp = registerFailure(emailIpBuckets, `${normalizedEmail}|${ip}`, EMAIL_IP_MAX, EMAIL_IP_LOCK_MS, now);
      const lockedIp = registerFailure(ipBuckets, ip, IP_MAX, IP_LOCK_MS, now);
      const lockedEmail = registerFailure(emailBuckets, normalizedEmail, EMAIL_MAX, EMAIL_LOCK_MS, now);
      if (lockedEmailIp || lockedIp || lockedEmail) {
        await db.auditLog
          .create({
            data: {
              userId: null,
              action: "LOGIN_LOCKED",
              recordType: "USER",
              recordId: user?.id ?? null,
              newValues: JSON.stringify({
                email: normalizedEmail,
                ip,
                userAgent,
                kind: lockedEmail ? "EMAIL" : lockedIp ? "IP" : "EMAIL_IP",
              }),
            },
          })
          .catch(() => undefined);
      }
      // Failed-login audit trail (without recording the attempted password).
      await db.auditLog
        .create({
          data: {
            userId: user?.id ?? null,
            action: "LOGIN_FAILED",
            recordType: "USER",
            recordId: user?.id ?? null,
            newValues: JSON.stringify({ email: normalizedEmail, ip, userAgent }),
          },
        })
        .catch(() => undefined);
      return fail("ایمیل یا پاسورد نادرست است.", 401);
    }
    if (!user.isActive) {
      // Only reachable with CORRECT credentials, so this message does not
      // help an attacker enumerate accounts (they would need the password).
      await db.auditLog
        .create({
          data: {
            userId: user.id,
            action: "LOGIN_INACTIVE",
            recordType: "USER",
            recordId: user.id,
            newValues: JSON.stringify({ email: normalizedEmail, ip, userAgent }),
          },
        })
        .catch(() => undefined);
      return fail("حساب کاربری شما غیرفعال است. با مدیر سیستم تماس بگیرید.", 403);
    }

    clearAll(normalizedEmail, ip, now);
    const token = await createSessionToken(user.id);
    await logAudit(user.id, "LOGIN", "USER", user.id, null, {
      at: formatJalali(new Date()),
      ip,
    });

    const response = ok({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role.name,
        roleDari: user.role.nameDari,
        checkpointId: user.checkpointId,
        checkpointName: user.checkpoint?.name ?? null,
      },
    });
    // Secure flag when TLS is terminated upstream (x-forwarded-proto: https);
    // SameSite=Strict — the cookie is never sent on cross-site requests.
    const isHttps = (request.headers.get("x-forwarded-proto") ?? "").includes("https");
    const cookie = [
      `${SESSION_COOKIE}=${token}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      isHttps ? "Secure" : "",
      "Max-Age=43200",
    ]
      .filter(Boolean)
      .join("; ");
    response.headers.append("Set-Cookie", cookie);
    return response;
  } catch (e) {
    return handleApiError(e);
  }
}
