import { z } from "zod";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/auth";
import { fail, handleApiError, ok, readJson, requireUser } from "@/lib/api";
import { startOfTodayKabul } from "@/lib/jalali";
import { ApiError, prepareEntry } from "@/lib/entry-service";
import { assertPortAccess } from "@/lib/scope";

const entryInclude = {
  importer: { select: { id: true, name: true, companyName: true, importerCode: true } },
  checkpoint: { select: { id: true, name: true, province: true } },
  creator: { select: { id: true, name: true } },
  approver: { select: { id: true, name: true } },
  rejecter: { select: { id: true, name: true } },
  items: {
    include: {
      item: { select: { id: true, itemName: true, itemCode: true, baseUomId: true, baseUom: { select: { id: true, name: true, symbol: true } } } },
      uom: true,
      exceptionRequester: { select: { name: true } },
      exceptionApprover: { select: { name: true } },
      exceptionRejecter: { select: { name: true } },
      importLimit: { select: { id: true, periodType: true, allowedQuantity: true, uomId: true, uom: { select: { name: true, symbol: true } } } },
    },
  },
  actions: {
    include: { actor: { select: { name: true } } },
    orderBy: { actionAt: "desc" as const },
  },
} as const;

async function loadEntry(id: number) {
  return db.importEntry.findUnique({ where: { id }, include: entryInclude });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireUser();
    if (auth.response) return auth.response;
    const { id } = await params;
    const entry = await loadEntry(Number(id));
    if (!entry) return fail("ثبت واردات مورد نظر پیدا نشد.", 404);
    const portError = assertPortAccess(auth.user, entry.checkpointId);
    if (portError) return fail(portError, 403);
    return ok({ entry });
  } catch (e) {
    return handleApiError(e);
  }
}

const entryUpdateSchema = z.object({
  importerId: z.number().int().optional(),
  checkpointId: z.number().int().optional(),
  importDatetime: z.string().min(1).optional(),
  vehicleNumber: z.string().nullable().optional(),
  remarks: z.string().nullable().optional(),
  action: z.enum(["draft", "submit"]).default("draft"),
  items: z
    .array(
      z.object({
        itemId: z.number().int(),
        quantity: z.number().positive("مقدار باید بزرگ‌تر از صفر باشد."),
        uomId: z.number().int(),
        remarks: z.string().nullable().optional(),
      })
    )
    .min(1, "لطفاً حداقل یک جنس اضافه کنید.")
    .optional(),
});

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireUser(["ADMIN", "OFFICER"]);
    if (auth.response) return auth.response;
    const { id } = await params;
    const parsed = await readJson(request, entryUpdateSchema);
    if (parsed.response) return parsed.response;
    const d = parsed.data;

    const existing = await loadEntry(Number(id));
    if (!existing) return fail("ثبت واردات مورد نظر پیدا نشد.", 404);
    const portError = assertPortAccess(auth.user, existing.checkpointId);
    if (portError) return fail(portError, 403);
    if (existing.status !== "DRAFT") {
      return fail("فقط ثبت‌های مسوده قابل ویرایش هستند.", 400);
    }
    if (existing.createdBy !== auth.user.id && auth.user.role !== "ADMIN") {
      return fail("فقط ثبت‌کننده ثبت می‌تواند آن را ویرایش کند.", 403);
    }

    const importerId = d.importerId ?? existing.importerId;
    const checkpointId = d.checkpointId ?? existing.checkpointId;
    // A port-restricted user can never move an entry to another port.
    const targetPortError = assertPortAccess(auth.user, checkpointId);
    if (targetPortError) return fail(targetPortError, 403);
    const importDatetime = d.importDatetime ? new Date(d.importDatetime) : existing.importDatetime;
    if (Number.isNaN(importDatetime.getTime())) return fail("تاریخ و ساعت واردات نامعتبر است.");
    if (importDatetime < startOfTodayKabul() && auth.user.role === "OFFICER" && importDatetime < existing.importDatetime) {
      return fail("ثبت تاریخ گذشته (بازتاریخ‌گذاری) برای کارمندان ثبت واردات مجاز نیست.");
    }

    const forSubmit = d.action === "submit";
    const result = await db.$transaction(async (tx) => {
      let prepared = await prepareEntry(
        d.items ??
          existing.items.map((it) => ({
            itemId: it.itemId,
            quantity: it.quantity,
            uomId: it.uomId,
            remarks: it.remarks,
          })),
        importerId,
        checkpointId,
        importDatetime,
        forSubmit,
        tx
      );
      const res = prepared.resolution;
      await tx.importEntryItem.deleteMany({ where: { importEntryId: existing.id } });
      await tx.importEntryItem.createMany({
        data: prepared.items.map((p) => ({
          importEntryId: existing.id,
          itemId: p.itemId,
          quantity: p.quantity,
          uomId: p.uomId,
          baseQuantity: p.baseQuantity,
          importLimitId: res ? res.quota.id : null,
          quotaUomQuantity: res ? p.quotaUomQuantity : null,
          quotaConversionFactor: res ? p.quotaConversionFactor : null,
          remarks: p.remarks ?? null,
        })),
      });
      const entry = await tx.importEntry.update({
        where: { id: existing.id },
        data: {
          importerId,
          checkpointId,
          importDatetime,
          vehicleNumber: d.vehicleNumber !== undefined ? d.vehicleNumber?.trim() || null : existing.vehicleNumber,
          remarks: d.remarks !== undefined ? d.remarks?.trim() || null : existing.remarks,
          // No approval workflow: submit = finalize immediately.
          status: forSubmit ? "APPROVED" : "DRAFT",
          // Charge snapshot is refreshed on every save (drafts clear it).
          // STRICT: within-quota only — the excess columns stay null.
          appliedLimitId: res ? res.quota.id : null,
          quotaSource: res ? res.source : null,
          chargedGroupId: res && res.source === "GROUP" ? res.quota.groupId : null,
          chargedGroupName: res && res.source === "GROUP" ? res.quota.groupName : null,
          quotaUomId: res ? res.quota.uomId : null,
          quotaChargedQuantity: res ? res.totalCharge : null,
          quotaExcessQuantity: null,
          excessReason: null,
          ...(forSubmit ? { approvedBy: auth.user.id, approvedAt: new Date() } : {}),
        },
        include: entryInclude,
      });

      if (forSubmit) {
        const actions = [
          {
            importEntryId: existing.id,
            actionType: "APPROVE",
            actionBy: auth.user.id,
            remarks:
              res?.source === "GROUP"
                ? `ثبت واردات — حد مجاز گروپ: ${res.quota.groupName ?? ""} (مصرف: ${res.totalCharge} ${res.quota.uomName})`
                : res
                  ? `ثبت واردات — حد مجاز فردی (مصرف: ${res.totalCharge} ${res.quota.uomName})`
                  : "ثبت واردات",
          },
        ];
        await tx.approvalAction.createMany({ data: actions });
      }
      await tx.auditLog.create({
        data: {
          userId: auth.user.id,
          action: "UPDATE",
          recordType: "IMPORT_ENTRY",
          recordId: existing.id,
          oldValues: JSON.stringify({ status: existing.status }),
          newValues: JSON.stringify({ status: entry.status }),
        },
      });
      return entry;
    });

    return ok({ entry: result });
  } catch (e) {
    if (e instanceof ApiError) return fail(e.message);
    return handleApiError(e);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireUser(["ADMIN", "OFFICER"]);
    if (auth.response) return auth.response;
    const { id } = await params;
    const existing = await db.importEntry.findUnique({ where: { id: Number(id) } });
    if (!existing) return fail("ثبت واردات مورد نظر پیدا نشد.", 404);
    const portError = assertPortAccess(auth.user, existing.checkpointId);
    if (portError) return fail(portError, 403);
    if (existing.status !== "DRAFT") {
      return fail("فقط ثبت‌های مسوده قابل حذف هستند.", 400);
    }
    if (existing.createdBy !== auth.user.id && auth.user.role !== "ADMIN") {
      return fail("فقط ثبت‌کننده ثبت می‌تواند آن را حذف کند.", 403);
    }
    await db.importEntry.delete({ where: { id: Number(id) } });
    await logAudit(auth.user.id, "DELETE", "IMPORT_ENTRY", existing.id, existing, null);
    return ok({ success: true });
  } catch (e) {
    return handleApiError(e);
  }
}
