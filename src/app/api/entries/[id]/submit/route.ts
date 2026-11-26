import { db } from "@/lib/db";
import { fail, handleApiError, ok, requireUser } from "@/lib/api";
import { startOfTodayKabul } from "@/lib/jalali";
import { ApiError, prepareEntry } from "@/lib/entry-service";
import { assertPortAccess } from "@/lib/scope";

/**
 * Finalize a DRAFT import entry (no approval workflow).
 *
 * The entry becomes APPROVED (ثبت‌شده) immediately: quota is re-validated
 * from fresh database state. STRICT ENFORCEMENT: finalizing is rejected
 * when the total charge exceeds the remaining shared balance — registration
 * beyond the quota limit is never permitted.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireUser(["ADMIN", "OFFICER"]);
    if (auth.response) return auth.response;
    const { id } = await params;

    const existing = await db.importEntry.findUnique({
      where: { id: Number(id) },
      include: {
        items: {
          include: {
            item: { include: { baseUom: true } },
          },
        },
      },
    });
    if (!existing) return fail("ثبت واردات مورد نظر پیدا نشد.", 404);
    const portError = assertPortAccess(auth.user, existing.checkpointId);
    if (portError) return fail(portError, 403);
    // IDEMPOTENT FINALIZE: repeating an already-successful finalize returns
    // the same finalized record instead of failing or re-processing.
    if (existing.status === "APPROVED") {
      return ok({ entry: existing, idempotentReplay: true });
    }
    if (existing.status !== "DRAFT") {
      return fail("فقط ثبت‌های مسوده قابل ثبت نهایی هستند.", 400);
    }
    if (existing.createdBy !== auth.user.id && auth.user.role !== "ADMIN") {
      return fail("فقط ثبت‌کننده ثبت می‌تواند آن را ثبت نهایی کند.", 403);
    }
    if (existing.importDatetime < startOfTodayKabul() && auth.user.role === "OFFICER") {
      return fail("ثبت تاریخ گذشته (بازتاریخ‌گذاری) برای کارمندان ثبت واردات مجاز نیست.");
    }

    const result = await db.$transaction(async (tx) => {
      const payload = existing.items.map((it) => ({
        itemId: it.itemId,
        quantity: it.quantity,
        uomId: it.uomId,
        remarks: it.remarks,
      }));
      // Fresh quota resolution INSIDE the transaction — concurrent
      // registrations see the latest committed group balance.
      const prepared = await prepareEntry(
        payload,
        existing.importerId,
        existing.checkpointId,
        existing.importDatetime,
        true,
        tx
      );
      const res = prepared.resolution!;
      await tx.importEntryItem.deleteMany({ where: { importEntryId: existing.id } });
      await tx.importEntryItem.createMany({
        data: prepared.items.map((p) => ({
          importEntryId: existing.id,
          itemId: p.itemId,
          quantity: p.quantity,
          uomId: p.uomId,
          baseQuantity: p.baseQuantity,
          importLimitId: res.quota.id,
          quotaUomQuantity: p.quotaUomQuantity,
          quotaConversionFactor: p.quotaConversionFactor,
          remarks: p.remarks ?? null,
        })),
      });

      const entry = await tx.importEntry.update({
        where: { id: existing.id },
        data: {
          status: "APPROVED",
          approvedBy: auth.user.id,
          approvedAt: new Date(),
          updatedAt: new Date(),
          appliedLimitId: res.quota.id,
          quotaSource: res.source,
          chargedGroupId: res.source === "GROUP" ? res.quota.groupId : null,
          chargedGroupName: res.source === "GROUP" ? res.quota.groupName : null,
          quotaUomId: res.quota.uomId,
          quotaChargedQuantity: res.totalCharge,
          quotaExcessQuantity: null,
          excessReason: null,
        },
        include: {
          items: { include: { item: { select: { itemName: true } } } },
        },
      });

      const actions = [
        {
          importEntryId: existing.id,
          actionType: "APPROVE",
          actionBy: auth.user.id,
          remarks:
            res.source === "GROUP"
              ? `ثبت واردات — حد مجاز گروپ: ${res.quota.groupName ?? ""} (مصرف: ${res.totalCharge} ${res.quota.uomName})`
              : `ثبت واردات — حد مجاز فردی (مصرف: ${res.totalCharge} ${res.quota.uomName})`,
        },
      ];
      await tx.approvalAction.createMany({ data: actions });
      await tx.auditLog.create({
        data: {
          userId: auth.user.id,
          action: "FINALIZE",
          recordType: "IMPORT_ENTRY",
          recordId: existing.id,
          oldValues: JSON.stringify({ status: existing.status }),
          newValues: JSON.stringify({ status: "APPROVED" }),
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
