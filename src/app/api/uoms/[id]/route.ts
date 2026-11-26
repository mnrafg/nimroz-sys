import { z } from "zod";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/auth";
import { fail, handleApiError, ok, readJson, requireUser } from "@/lib/api";

const uomUpdateSchema = z.object({
  code: z.string().min(1).optional(),
  name: z.string().min(2).optional(),
  symbol: z.string().min(1).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireUser(["ADMIN"]);
    if (auth.response) return auth.response;
    const { id } = await params;
    const parsed = await readJson(request, uomUpdateSchema);
    if (parsed.response) return parsed.response;

    const existing = await db.uom.findUnique({ where: { id: Number(id) } });
    if (!existing) return ok({ error: "واحد مورد نظر پیدا نشد." }, 404);

    const data = parsed.data;
    const uom = await db.uom.update({
      where: { id: Number(id) },
      data: {
        ...data,
        code: data.code?.trim().toUpperCase(),
        name: data.name?.trim(),
        symbol: data.symbol?.trim(),
      },
    });
    await logAudit(auth.user.id, "UPDATE", "UOM", uom.id, existing, uom);
    return ok({ uom });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireUser(["ADMIN"]);
    if (auth.response) return auth.response;
    const { id } = await params;
    const uomId = Number(id);
    const existing = await db.uom.findUnique({
      where: { id: uomId },
      include: { _count: { select: { items: true, limitUoms: true, entryItems: true, conversionsFrom: true, conversionsTo: true } } },
    });
    if (!existing) return ok({ error: "واحد مورد نظر پیدا نشد." }, 404);

    // Referential integrity: a UOM used by items/limits/entries/conversions
    // can only be deactivated, never deleted.
    const inUse =
      existing._count.items > 0 ||
      existing._count.limitUoms > 0 ||
      existing._count.entryItems > 0 ||
      existing._count.conversionsFrom > 0 ||
      existing._count.conversionsTo > 0;
    if (inUse) {
      return fail(
        "این واحد در اجناس، حد مجاز، ثبت‌های واردات یا تبدیل واحدات استفاده شده است؛ حذف ممکن نیست. می‌توانید آن را غیرفعال کنید.",
        409
      );
    }

    await db.uom.delete({ where: { id: uomId } });
    await logAudit(auth.user.id, "DELETE", "UOM", uomId, existing, null);
    return ok({ success: true });
  } catch (e) {
    return handleApiError(e);
  }
}
