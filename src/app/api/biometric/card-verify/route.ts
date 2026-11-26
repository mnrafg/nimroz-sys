import { db } from "@/lib/db";
import { parseCardToken } from "@/lib/biometric/matcher";

/**
 * Public card verification endpoint — the target of the ID-card QR code.
 * Returns a minimal, self-contained HTML page (or JSON when requested).
 * Only non-sensitive fields are exposed. The token is an opaque, signed
 * identifier; verification fails as soon as the importer is deactivated
 * (revocable).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("t") ?? "";
  const wantsJson = (request.headers.get("accept") ?? "").includes("application/json");

  const cardNumber = parseCardToken(token);
  if (!cardNumber) {
    return pageOrJson(wantsJson, invalidHtml("توکن کارت نامعتبر است."), { valid: false, reason: "INVALID_TOKEN" });
  }

  const importer = await db.importer.findFirst({
    where: { idCardNumber: cardNumber },
    select: {
      importerCode: true,
      name: true,
      fatherName: true,
      companyName: true,
      status: true,
      biometricStatus: true,
      photoData: true,
    },
  });

  if (!importer) {
    return pageOrJson(wantsJson, invalidHtml("کارت شناسایی یافت نشد."), { valid: false, reason: "NOT_FOUND" });
  }
  if (importer.status !== "ACTIVE") {
    return pageOrJson(
      wantsJson,
      invalidHtml("این کارت ابطال شده است (واردکننده غیرفعال)."),
      { valid: false, reason: "REVOKED" }
    );
  }

  const html = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>تأیید کارت شناسایی — شرکت نفت و گاز افغانستان</title>
<style>
  body { font-family: system-ui, "Vazirmatn", "Segoe UI", Tahoma, sans-serif; background:#F4F6F7; margin:0; padding:24px; }
  .card { max-width:420px; margin:32px auto; background:#fff; border:1px solid #E2E8F0; border-radius:14px; overflow:hidden; box-shadow:0 6px 24px rgba(0,0,0,.08); }
  .head { background:#005963; color:#fff; padding:14px 18px; display:flex; align-items:center; gap:12px; }
  .head .t1 { font-weight:700; font-size:15px; }
  .head .t2 { font-size:12px; opacity:.8; }
  .body { padding:18px; display:flex; gap:16px; }
  .photo { width:96px; height:110px; border-radius:10px; background:#F1F5F5; border:1px solid #E2E8F0; object-fit:cover; flex-shrink:0; }
  .rows { flex:1; }
  .row { display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px dashed #EDF1F4; font-size:13px; }
  .row span:first-child { color:#7C7C7C; }
  .row span:last-child { font-weight:600; color:#171717; }
  .badge { display:inline-block; margin:14px 18px 18px; padding:5px 12px; border-radius:999px; font-size:12px; font-weight:700; background:#E7F5EE; color:#116149; border:1px solid #BFE5D2; }
</style>
</head>
<body>
  <div class="card">
    <div class="head">
      <div>
        <div class="t1">شرکت نفت و گاز افغانستان</div>
        <div class="t2">تأیید کارت شناسایی واردکننده — سیستم کنترل واردات مرزی</div>
      </div>
    </div>
    <div class="body">
      ${importer.photoData ? `<img class="photo" src="data:image/jpeg;base64,${importer.photoData}" alt="عکس واردکننده" />` : `<div class="photo"></div>`}
      <div class="rows">
        <div class="row"><span>نام واردکننده</span><span>${escapeHtml(importer.name)}</span></div>
        ${importer.fatherName ? `<div class="row"><span>نام پدر</span><span>${escapeHtml(importer.fatherName)}</span></div>` : ""}
        <div class="row"><span>نمبر واردکننده</span><span dir="ltr">${escapeHtml(importer.importerCode)}</span></div>
        <div class="row"><span>شماره کارت</span><span dir="ltr">${escapeHtml(cardNumber)}</span></div>
        ${importer.companyName ? `<div class="row"><span>شرکت</span><span>${escapeHtml(importer.companyName)}</span></div>` : ""}
      </div>
    </div>
    <span class="badge">✓ کارت معتبر است — وضعیت: فعال</span>
  </div>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function invalidHtml(message: string): string {
  return `<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8" /><title>کارت نامعتبر</title></head>
<body style="font-family:system-ui,Tahoma,sans-serif;background:#F4F6F7;padding:40px;text-align:center;">
<div style="max-width:420px;margin:60px auto;background:#fff;border:1px solid #F2C4C4;border-radius:14px;padding:28px;box-shadow:0 6px 24px rgba(0,0,0,.08);">
<div style="font-size:40px;">✕</div>
<h1 style="font-size:17px;color:#8C2F2F;">کارت شناسایی تأیید نشد</h1>
<p style="font-size:13px;color:#7C7C7C;">${escapeHtml(message)}</p>
<p style="font-size:12px;color:#9CA3AF;">شرکت نفت و گاز افغانستان — سیستم کنترل واردات مرزی</p>
</div></body></html>`;
}

function pageOrJson(wantsJson: boolean, html: string, json: object): Response {
  if (wantsJson) return Response.json(json);
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
