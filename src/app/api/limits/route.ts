import { z } from "zod";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/auth";
import { fail, handleApiError, ok, readJson, requireUser } from "@/lib/api";
import { findOverlappingQuota, MAX_VALID_DATE } from "@/lib/quota";
import { requirePortScope, scopedCheckpointFilter } from "@/lib/scope";

export async function GET(request: Request) {
  try {
    const auth = await requireUser();
    if (auth.response) return auth.response;
    // Quota records are operational data — port-scoped, server-enforced.
    const scopeCheck = requirePortScope(auth.user);
    if (!scopeCheck.ok) return fail(scopeCheck.message, 403);
    const { searchParams } = new URL(request.url);
    const importerId = searchParams.get("importerId");
    const groupId = searchParams.get("groupId");
    const ownerType = searchParams.get("ownerType");
    const checkpointId = searchParams.get("checkpointId");
    const status = searchParams.get("status"); // active | inactive
    const limits = await db.importLimit.findMany({
      where: {
        AND: [
          importerId ? { importerId: Number(importerId) } : {},
          groupId ? { groupId: Number(groupId) } : {},
          ownerType ? { ownerType } : {},
          scopedCheckpointFilter(auth.user, checkpointId ? Number(checkpointId) : null),
          status === "active" ? { isActive: true } : status === "inactive" ? { isActive: false } : {},
        ],
      },
      include: {
        // groupId on the importer — lets the UI filter INDIVIDUAL quotas by
        // the owner's group membership (group quotas carry their own groupId).
        importer: { select: { id: true, name: true, companyName: true, importerCode: true, groupId: true } },
        group: { select: { id: true, name: true, code: true, representative: { select: { id: true, name: true, importerCode: true } }, _count: { select: { members: { where: { membershipStatus: "ACTIVE" } } } } } },
        checkpoint: { select: { id: true, name: true, province: true } },
        restrictItem: { select: { id: true, itemName: true, itemCode: true } },
        restrictCategory: { select: { id: true, name: true } },
        uom: { select: { id: true, name: true, symbol: true } },
        creator: { select: { name: true } },
      },
      orderBy: { updatedAt: "desc" },
    });
    return ok({ limits });
  } catch (e) {
    return handleApiError(e);
  }
}

const limitSchema = z
  .object({
    ownerType: z.enum(["INDIVIDUAL", "GROUP"], { message: "لطفاً نوع حد مجاز را انتخاب کنید." }),
    importerId: z.number().int().nullable().optional(),
    groupId: z.number().int().nullable().optional(),
    checkpointId: z.number({ message: "لطفاً بندر را انتخاب کنید." }).int(),
    // NO item — the quota is a shared TOTAL-QUANTITY balance. Optional
    // eligibility restriction only.
    allowedQuantity: z
      .number({ message: "لطفاً مقدار مجاز را بنویسید." })
      .positive("مقدار مجاز باید بزرگ‌تر از صفر باشد."),
    uomId: z.number({ message: "لطفاً واحد اندازه‌گیری را انتخاب کنید." }).int(),
    periodType: z.enum(["DAILY", "WEEKLY", "MONTHLY", "TOTAL"], {
      message: "لطفاً مدت حد مجاز را انتخاب کنید.",
    }),
    effectiveFrom: z.string({ message: "لطفاً تاریخ شروع را انتخاب کنید." }).min(1),
    effectiveTo: z.string().nullable().optional(),
    isActive: z.boolean().default(true),
    restrictItemId: z.number().int().nullable().optional(),
    restrictCategoryId: z.number().int().nullable().optional(),
  })
  .refine((d) => (d.ownerType === "INDIVIDUAL" ? d.importerId != null : d.groupId != null), {
    message: "لطفاً صاحب حد مجاز را مشخص کنید.",
  });

export async function POST(request: Request) {
  try {
    const auth = await requireUser(["ADMIN"]);
    if (auth.response) return auth.response;
    const parsed = await readJson(request, limitSchema);
    if (parsed.response) return parsed.response;
    const d = parsed.data;

    const effectiveFrom = new Date(d.effectiveFrom);
    const effectiveTo = d.effectiveTo ? new Date(d.effectiveTo) : null;
    if (effectiveTo && effectiveTo < effectiveFrom) {
      return fail("تاریخ ختم نمی‌تواند قبل از تاریخ شروع باشد.");
    }

    // Validate the owner.
    if (d.ownerType === "INDIVIDUAL") {
      const importer = await db.importer.findUnique({ where: { id: d.importerId! } });
      if (!importer) return fail("واردکننده مورد نظر پیدا نشد.", 400);
      if (importer.status !== "ACTIVE") return fail("برای واردکننده غیرفعال نمی‌توان حد مجاز تعیین کرد.", 400);
    } else {
      const group = await db.importerGroup.findUnique({ where: { id: d.groupId! } });
      if (!group) return fail("گروپ مورد نظر پیدا نشد.", 400);
      if (group.status !== "ACTIVE") return fail("برای گروپ غیرفعال نمی‌توان حد مجاز تعیین کرد.", 400);
    }

    // Optional restriction must exist.
    if (d.restrictItemId != null) {
      const item = await db.item.findUnique({ where: { id: d.restrictItemId } });
      if (!item) return fail("جنس محدودیت انتخاب‌شده موجود نیست.", 400);
    }
    if (d.restrictCategoryId != null) {
      const cat = await db.itemCategory.findUnique({ where: { id: d.restrictCategoryId } });
      if (!cat) return fail("دسته محدودیت انتخاب‌شده موجود نیست.", 400);
    }
    if (d.restrictItemId != null && d.restrictCategoryId != null) {
      return fail("می‌توانید فقط یک نوع محدودیت (جنس یا دسته) انتخاب کنید.", 400);
    }

    // UOM compatibility sanity: at least one ACTIVE item must be able to
    // consume this quota (convertible to the quota UOM) — otherwise the
    // quota can never be used.
    const quotaUom = await db.uom.findUnique({ where: { id: d.uomId } });
    if (!quotaUom) return fail("واحد اندازه‌گیری انتخاب‌شده موجود نیست.", 400);

    // ONE active quota per (owner, port, UOM) — the item is no longer part
    // of the quota identity.
    const overlapping = await findOverlappingQuota({
      ownerType: d.ownerType,
      importerId: d.ownerType === "INDIVIDUAL" ? d.importerId ?? null : null,
      groupId: d.ownerType === "GROUP" ? d.groupId ?? null : null,
      checkpointId: d.checkpointId,
      uomId: d.uomId,
      effectiveFrom,
      effectiveTo,
    });
    if (overlapping) {
      const ownerName =
        overlapping.ownerType === "GROUP"
          ? `گروپ «${overlapping.group?.name ?? ""}»`
          : `واردکننده «${overlapping.importer?.name ?? ""}»`;
      return fail(
        `برای ${ownerName} در این بندر با واحد ${overlapping.uom.name} یک حد مجاز فعال موجود است (مقدار: ${overlapping.allowedQuantity} — ${overlapping.periodType}). دو حد فعال با واحد مشابه تداخل دارند.`,
        409
      );
    }

    const limit = await db.importLimit.create({
      data: {
        ownerType: d.ownerType,
        importerId: d.ownerType === "INDIVIDUAL" ? d.importerId ?? null : null,
        groupId: d.ownerType === "GROUP" ? d.groupId ?? null : null,
        checkpointId: d.checkpointId,
        allowedQuantity: d.allowedQuantity,
        uomId: d.uomId,
        periodType: d.periodType,
        effectiveFrom,
        effectiveTo,
        isActive: d.isActive,
        restrictItemId: d.restrictItemId ?? null,
        restrictCategoryId: d.restrictCategoryId ?? null,
        createdBy: auth.user.id,
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
    await logAudit(auth.user.id, "CREATE", "IMPORT_LIMIT", limit.id, null, limit);
    return ok({ limit }, 201);
  } catch (e) {
    return handleApiError(e);
  }
}
