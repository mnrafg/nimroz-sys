import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ingestTerminalScan } from "@/lib/biometric/terminal-ingestion";
import { normalizeSerial, parseDeviceLocalTimestamp, DEFAULT_TZ_OFFSET_MINUTES } from "@/lib/biometric/terminal-rules";
import { canonicalIngestionString, safeEqualHex, signWithSalt } from "@/lib/biometric/terminal-security";

// ============================================================
// POST /api/biometric/terminal/ingest
// Legacy SIGNED ingestion path (RELAY compat) for supported legacy
// transports. Requires per-device credential-salt HMAC over the
// canonical request string + replay receipts. Machine endpoint —
// never called by browsers. Disabled when the device has no salt.
// ============================================================

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 512 * 1024;
const MAX_LINES = 100;
const FRESH_WINDOW_MS = 60_000;

export async function POST(request: Request) {
  const serial = normalizeSerial(request.headers.get("x-aogc-serial"));
  const timestamp = Number(request.headers.get("x-aogc-timestamp") ?? "");
  const nonce = (request.headers.get("x-aogc-nonce") ?? "").slice(0, 64);
  const signature = (request.headers.get("x-aogc-signature") ?? "").toLowerCase();
  if (!serial || !Number.isFinite(timestamp) || !nonce || !/^[0-9a-f]{64}$/.test(signature)) {
    return NextResponse.json({ error: "درخواست امضاشده نامعتبر است." }, { status: 401 });
  }
  if (Math.abs(Date.now() - timestamp) > FRESH_WINDOW_MS) {
    return NextResponse.json({ error: "زمان درخواست خارج از پنجره مجاز است." }, { status: 401 });
  }
  const device = await db.terminalDevice.findUnique({ where: { serial } });
  if (!device || !device.credentialSalt || !device.isEnabled) {
    return NextResponse.json({ error: "دستگاه امضا پذیرفته نمی‌شود." }, { status: 401 });
  }
  const bodyText = await request.text().catch(() => "");
  if (!bodyText || bodyText.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "متن درخواست نامعتبر است." }, { status: 400 });
  }

  const expected = signWithSalt(
    device.credentialSalt,
    canonicalIngestionString({ serial, body: bodyText, timestampMs: timestamp, nonce })
  );
  if (!safeEqualHex(expected, signature)) {
    return NextResponse.json({ error: "امضا تأیید نشد." }, { status: 401 });
  }

  // replay protection — one receipt per (timestamp, nonce, signature)
  const receiptId = `${timestamp}:${nonce}:${expected.slice(0, 16)}`;
  try {
    await db.terminalReceipt.create({
      data: { id: receiptId, deviceKey: serial, expiresAt: new Date(Date.now() + 10 * 60_000) },
    });
  } catch {
    return NextResponse.json({ error: "این درخواست قبلاً دریافت شده است (پخش مجدد رد شد)." }, { status: 409 });
  }

  const lines = bodyText.split(/\r\n|\n/).filter((l) => l.trim()).slice(0, MAX_LINES);
  let accepted = 0;
  for (const line of lines) {
    const fields = line.replace(/^TRANS/, "").split("\t");
    if (fields.length < 4) continue;
    const [userId, ts, punchRaw, verifyRaw] = fields;
    if (!/^\d{1,9}$/.test(userId.trim())) continue;
    const localMs = parseDeviceLocalTimestamp(ts.trim());
    if (localMs === null) continue;
    const punch = Number.parseInt(punchRaw.trim(), 10);
    const verify = Number.parseInt(verifyRaw.trim(), 10);
    if (!Number.isInteger(punch) || !Number.isInteger(verify)) continue;
    const result = await ingestTerminalScan({
      serial,
      terminalUserId: userId.trim(),
      punch,
      verify,
      deviceLocalMs: localMs,
      timezoneOffsetMinutes: device.timezoneOffsetMinutes ?? DEFAULT_TZ_OFFSET_MINUTES,
    });
    if (result.ok) accepted += 1;
  }
  return NextResponse.json({ accepted }, { status: 200 });
}
