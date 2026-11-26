"use client";

// ============================================================
// Client-side photo downsizing for importer registration.
// Produces a compact base64 JPEG (max 480px, ~80% quality) so the
// photo can be stored with the importer record without bloating
// the database or API responses.
// ============================================================

const MAX_DIM = 480;

export async function fileToResizedJpeg(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("لطفاً یک فایل عکس انتخاب کنید.");
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("خواندن فایل ناموفق بود."));
    reader.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("فایل عکس نامعتبر است."));
    image.src = dataUrl;
  });

  const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("پردازش عکس ممکن نشد.");
  ctx.drawImage(img, 0, 0, w, h);
  const out = canvas.toDataURL("image/jpeg", 0.8);
  const base64 = out.slice(out.indexOf(",") + 1);
  if (base64.length > 600_000) {
    throw new Error("حجم عکس زیاد است؛ لطفاً عکس کوچک‌تر انتخاب کنید.");
  }
  return base64;
}
