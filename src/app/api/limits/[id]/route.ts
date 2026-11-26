import { z } from "zod";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/auth";
import { fail, handleApiError, ok, readJson, requireUser } from "@/lib/api";
import { findOverlappingQuota } from "@/lib/quota";

const limitUpdateSchema = z.object({
  allowedQuantity: z.number().positive("مقدار مجاز باید بزرگ‌تر از صفر باشد.").optional(),
  isActive: z.boolean().optional(),
  // Quota changes record old value, new value, actor, timestamp AND reason.
  changeReason: z.string().nullable().optional(),
});

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireUser(["ADMIN"]);
    if (auth.response) return auth.response;
    const { id } = await params;
    const parsed = await readJson(request, limitUpdateSchema);
    if (parsed.response) return parsed.response;

    const existing = await db.importLimit.findUnique({
      where: { id: Number(id) },
      include: {
        importer: { select: { name: true, companyName: true } },
        group: { select: { name: true } },
        checkpoint: { select: { name: true } },
        uom: true,
      },
    });
    if (!existing) return ok({ error: "حد مجاز مورد نظر پیدا نشد." }, 404);

    // If re-activating, check overlap with other active quotas
    if (parsed.data.isActive === true && !existing.isActive) {
      const overlapping = await findOverlappingQuota({
        ownerType: existing.ownerType as "INDIVIDUAL" | "GROUP",
        importerId: existing.importerId,
        groupId: existing.groupId,
        checkpointId: existing.checkpointId,
        uomId: existing.uomId,
        effectiveFrom: existing.effectiveFrom,
        effectiveTo: existing.effectiveTo,
        excludeId: existing.id,
      });
      if (overlapping) {
        return fail(
          "برای این صاحب حد مجاز در این بندر قبلاً یک حد مجاز فعال با همین واحد موجود است؛ فعال‌سازی هم‌زمان دو حد ممکن نیست.",
          409
        );
      }
    }

    // A genuine reason is REQUIRED when the authorized amount changes —
    // never fabricated or auto-filled.
    if (
      parsed.data.allowedQuantity !== undefined &&
      parsed.data.allowedQuantity !== existing.allowedQuantity &&
      !parsed.data.changeReason?.trim()
    ) {
      return fail("برای تغییر مقدار حد مجاز، نوشتن دلیل ضروری است.");
    }

    const limit = await db.importLimit.update({
      where: { id: Number(id) },
      data: {
        allowedQuantity: parsed.data.allowedQuantity,
        isActive: parsed.data.isActive,
        // Quantity changes take effect from NOW — historical charges keep
        // their stored values, so past consumption never moves.
        ...(parsed.data.allowedQuantity !== undefined && parsed.data.allowedQuantity !== existing.allowedQuantity
          ? { effectiveFrom: parsed.data.allowedQuantity !== undefined ? existing.effectiveFrom : existing.effectiveFrom }
          : {}),
      },
      include: {
        importer: { select: { name: true, companyName: true } },
        group: { select: { name: true } },
        checkpoint: { select: { name: true } },
        uom: true,
        restrictItem: { select: { itemName: true } },
        restrictCategory: { select: { name: true } },
      },
    });
    await logAudit(
      auth.user.id,
      "UPDATE",
      "IMPORT_LIMIT",
      limit.id,
      { allowedQuantity: existing.allowedQuantity, isActive: existing.isActive },
      {
        allowedQuantity: limit.allowedQuantity,
        isActive: limit.isActive,
        reason: parsed.data.changeReason?.trim() || null,
      }
    );
    return ok({ limit });
  } catch (e) {
    return handleApiError(e);
  }
}
