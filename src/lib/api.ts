import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, SessionUser } from "@/lib/auth";

export function ok(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export function fail(message: string, status = 400, headers?: Record<string, string>) {
  return NextResponse.json({ error: message }, { status, headers });
}

/**
 * Short, sanitized correlation reference printed for support. It carries
 * NO exception detail — it only lets an administrator match a UI error
 * with one server log line.
 */
export function newDiagnosticRef(prefix = "ERR"): string {
  const t = Date.now().toString(36).toUpperCase().slice(-6);
  const r = Math.random().toString(36).toUpperCase().slice(2, 6);
  return `${prefix}-${t}-${r}`;
}

type AuthResult =
  | { user: SessionUser; response?: undefined }
  | { user?: undefined; response: NextResponse };

export async function requireUser(roles?: string[]): Promise<AuthResult> {
  const user = await getSessionUser();
  if (!user) {
    return { response: fail("نشست شما منقضی شده است. لطفاً دوباره وارد سیستم شوید.", 401) };
  }
  if (roles && !roles.includes(user.role)) {
    return { response: fail("شما اجازه انجام این عملیه را ندارید.", 403) };
  }
  return { user };
}

/**
 * JSON-body size ceiling (V16 fix) — defends every endpoint that parses
 * JSON against "JSON bomb" / memory-exhaustion DoS. Must comfortably
 * cover the largest legitimate payload (importer photo ≈ 2.6 MB base64).
 */
const MAX_JSON_BYTES = 4 * 1024 * 1024;

export async function readJson<T>(
  request: Request,
  schema: z.ZodType<T>
): Promise<{ data: T; response?: undefined } | { data?: undefined; response: NextResponse }> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
    return { response: fail("حجم داده‌ی ارسال‌شده بیش از حد مجاز است.", 413) };
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { response: fail("داده‌های ارسال‌شده نامعتبر است.") };
  }
  if (text.length > MAX_JSON_BYTES) {
    return { response: fail("حجم داده‌ی ارسال‌شده بیش از حد مجاز است.", 413) };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { response: fail("داده‌های ارسال‌شده نامعتبر است.") };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const msg =
      issue?.message && issue.message !== "Required"
        ? issue.message
        : "لطفاً تمام فیلدهای ضروری را درست خانه‌پری نمایید.";
    return { response: fail(msg) };
  }
  return { data: parsed.data };
}

export function handleApiError(e: unknown) {
  // Full details stay in the SERVER log only — raw exception text (Prisma
  // internals, table/column names, stack traces) is never returned to the
  // client, so error messages cannot be used to probe the backend.
  const ref = newDiagnosticRef();
  console.error(`[api-error ref=${ref}]`, e);
  const raw = e instanceof Error ? e.message : "";
  if (raw.includes("Unique constraint")) {
    if (raw.includes("importerCode")) return fail("این نمبر واردکننده از قبل موجود است.", 409);
    if (raw.includes("itemCode")) return fail("این نمبر جنس از قبل موجود است.", 409);
    if (raw.includes("uomCode") || raw.includes("code")) return fail("این کود از قبل موجود است.", 409);
    return fail("این رکورد از قبل موجود است (مقدار تکراری).", 409);
  }
  // Sanitized 500 with a correlation reference — the UI shows the Dari
  // message plus «کد پیگیری» so a failed request is distinguishable from
  // an empty result and support can find the exact server log line.
  return NextResponse.json(
    { error: "خطای غیرمنتظره در سرور رخ داد؛ لطفاً دوباره تلاش کنید.", ref },
    { status: 500 }
  );
}

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Error type for business-rule violations whose Dari message is safe to
 * show to the client (V12 fix). Only instances of THIS class are echoed
 * back — raw exception text (Prisma internals, stack traces …) always
 * goes through `handleApiError` and stays in the server log.
 */
export class FriendlyApiError extends Error {}

/**
 * Password policy shared by user create/update endpoints (V7 fix,
 * hardened: rejects widely-burned passwords from breach corpora and
 * passwords that embed the account's own email prefix).
 */
const COMMON_PASSWORDS = new Set([
  "password", "password1", "password12", "password123", "passw0rd", "p@ssw0rd",
  "12345678", "123456789", "1234567890", "abc12345", "qwerty123", "qwerty12345",
  "iloveyou", "admin123", "admin@123", "administrator", "letmein", "letmein123",
  "welcome1", "welcome123", "monkey123", "dragon123", "sunshine1", "football1",
  "princess1", "master123", "aogc1234", "aogc@123", "kabul1234", "afghan123",
]);

export function validatePasswordStrength(pw: string, email?: string | null): string | null {
  if (pw.length < 8) return "پاسورد باید حداقل ۸ حرف باشد.";
  if (!/[A-Za-z]/.test(pw)) return "پاسورد باید حداقل یک حرف انگلیسی داشته باشد.";
  if (!/[0-9]/.test(pw)) return "پاسورد باید حداقل یک رقم داشته باشد.";
  const lower = pw.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) {
    return "این پاسورد بسیار رایج و ناامن است؛ لطفاً پاسورد دیگری انتخاب کنید.";
  }
  const localPart = email?.split("@")[0]?.trim().toLowerCase();
  if (localPart && localPart.length >= 3 && lower.includes(localPart)) {
    return "پاسورد نباید شامل بخش اصلی آدرس ایمیل شما باشد.";
  }
  return null;
}
