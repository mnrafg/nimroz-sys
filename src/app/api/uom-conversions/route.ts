import { z } from "zod";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/auth";
import { fail, handleApiError, ok, readJson, requireUser } from "@/lib/api";

export async function GET(request: Request) {
  try {
    const auth = await requireUser();
    if (auth.response) return auth.response;
    const { searchParams } = new URL(request.url);
    const itemId = searchParams.get("itemId");
    const conversions = await db.uomConversion.findMany({
      where: itemId ? { itemId: Number(itemId) } : {},
      include: {
        item: { select: { itemName: true, itemCode: true } },
        fromUom: { select: { name: true, symbol: true } },
        toUom: { select: { name: true, symbol: true } },
      },
      orderBy: { id: "asc" },
    });
    return ok({ conversions });
  } catch (e) {
    return handleApiError(e);
  }
}

const convSchema = z.object({
  itemId: z.number({ message: "لطفاً جنس را انتخاب کنید." }).int(),
  fromUomId: z.number({ message: "لطفاً واحد مبدأ را انتخاب کنید." }).int(),
  toUomId: z.number({ message: "لطفاً واحد مقصد را انتخاب کنید." }).int(),
  conversionFactor: z
    .number({ message: "لطفاً ضریب تبدیل را بنویسید." })
    .positive("ضریب تبدیل باید بزرگ‌تر از صفر باشد."),
});

export async function POST(request: Request) {
  try {
    const auth = await requireUser(["ADMIN"]);
    if (auth.response) return auth.response;
    const parsed = await readJson(request, convSchema);
    if (parsed.response) return parsed.response;
    const { itemId, fromUomId, toUomId, conversionFactor } = parsed.data;
    if (fromUomId === toUomId) {
      return fail("واحد مبدأ و مقصد نمی‌تواند یکسان باشد.");
    }
    const existing = await db.uomConversion.findFirst({
      where: { itemId, fromUomId, toUomId },
    });
    if (existing) {
      return fail("برای این جنس و واحدات، تبدیل از قبل تعریف شده است.", 409);
    }
    // CONFLICTING REVERSE detection — a reverse conversion with a different
    // factor would create an inconsistent cycle (LTR→TON=1056 but TON→LTR=1000).
    const reverse = await db.uomConversion.findFirst({
      where: { itemId, fromUomId: toUomId, toUomId: fromUomId },
    });
    if (reverse) {
      const expected = 1 / conversionFactor;
      const tolerance = Math.abs(reverse.conversionFactor - expected) > 1e-6;
      if (tolerance) {
        return fail(
          "برای این جنس، تبدیل معکوس با ضریب متفاوت از قبل تعریف شده است؛ ثبت دو تبدیل ناسازگار ممکن نیست. ابتدا تبدیل معکوس را اصلاح یا حذف کنید.",
          409
        );
      }
    }
    // Destination must be ACTIVE — historical conversions keep working, but
    // new selections involving inactive units are blocked.
    const [fromUom, toUom] = await Promise.all([
      db.uom.findUnique({ where: { id: fromUomId } }),
      db.uom.findUnique({ where: { id: toUomId } }),
    ]);
    if (!fromUom || !toUom) return fail("واحد انتخاب‌شده موجود نیست.", 400);
    if (fromUom.status !== "ACTIVE" || toUom.status !== "ACTIVE") {
      return fail("واحد غیرفعال برای تعریف تبدیل جدید قابل انتخاب نیست.", 400);
    }
    const conversion = await db.uomConversion.create({
      data: { itemId, fromUomId, toUomId, conversionFactor },
      include: {
        item: { select: { itemName: true, itemCode: true } },
        fromUom: { select: { name: true, symbol: true } },
        toUom: { select: { name: true, symbol: true } },
      },
    });
    await logAudit(auth.user.id, "CREATE", "UOM_CONVERSION", conversion.id, null, conversion);
    return ok({ conversion }, 201);
  } catch (e) {
    return handleApiError(e);
  }
}
