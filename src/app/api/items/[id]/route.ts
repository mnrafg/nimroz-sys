import { z } from "zod";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/auth";
import { fail, handleApiError, ok, readJson, requireUser } from "@/lib/api";

const itemUpdateSchema = z.object({
  itemCode: z.string().min(1).optional(),
  itemName: z.string().min(2).optional(),
  categoryId: z.number().int().nullable().optional(),
  baseUomId: z.number().int().optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  description: z.string().nullable().optional(),
});

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireUser(["ADMIN"]);
    if (auth.response) return auth.response;
    const { id } = await params;
    const parsed = await readJson(request, itemUpdateSchema);
    if (parsed.response) return parsed.response;

    const existing = await db.item.findUnique({ where: { id: Number(id) } });
    if (!existing) return ok({ error: "جنس مورد نظر پیدا نشد." }, 404);

    const data = parsed.data;
    const item = await db.item.update({
      where: { id: Number(id) },
      data: {
        ...data,
        itemCode: data.itemCode?.trim(),
        itemName: data.itemName?.trim(),
      },
    });
    await logAudit(auth.user.id, existing.status !== item.status ? "STATUS_CHANGE" : "UPDATE", "ITEM", item.id, existing, item);
    return ok({ item });
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
    const itemId = Number(id);
    const existing = await db.item.findUnique({
      where: { id: itemId },
      include: { _count: { select: { entryItems: true, restrictLimits: true, conversions: true } } },
    });
    if (!existing) return ok({ error: "جنس مورد نظر پیدا نشد." }, 404);

    // Referential integrity: items already used operationally can only be
    // deactivated — deleting them would corrupt quota/history semantics.
    if (existing._count.entryItems > 0 || existing._count.restrictLimits > 0 || existing._count.conversions > 0) {
      return fail(
        "این جنس در ثبت‌های واردات، حد مجاز یا تبدیل واحدات استفاده شده است؛ حذف ممکن نیست. می‌توانید آن را غیرفعال کنید.",
        409
      );
    }

    await db.item.delete({ where: { id: itemId } });
    await logAudit(auth.user.id, "DELETE", "ITEM", itemId, existing, null);
    return ok({ success: true });
  } catch (e) {
    return handleApiError(e);
  }
}
