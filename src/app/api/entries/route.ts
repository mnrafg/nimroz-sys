import { z } from "zod";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/auth";
import { fail, handleApiError, ok, readJson, requireUser } from "@/lib/api";
import { startOfTodayKabul } from "@/lib/jalali";
import { normalizeDigits } from "@/lib/normalize";
import { ApiError, generateEntryNumber, prepareEntry } from "@/lib/entry-service";
import { findIdempotentRecord, recordIdempotency } from "@/lib/idempotency";
import { requirePortScope, scopedCheckpointFilter, assertPortAccess } from "@/lib/scope";

const entrySchema = z.object({
  importerId: z.number({ message: "لطفاً واردکننده را انتخاب کنید." }).int(),
  checkpointId: z.number({ message: "لطفاً بندر را انتخاب کنید." }).int(),
  importDatetime: z.string({ message: "لطفاً تاریخ و ساعت واردات را تعیین کنید." }).min(1),
  vehicleNumber: z.string().nullable().optional(),
  remarks: z.string().nullable().optional(),
  action: z.enum(["draft", "submit"]),
  /** Client-generated retry key: resubmitting the SAME request replays the
   *  SAME created record instead of creating a duplicate registration. */
  idempotencyKey: z.string().nullable().optional(),
  items: z
    .array(
      z.object({
        itemId: z.number().int(),
        quantity: z.number({ message: "لطفاً مقدار جنس را بنویسید." }).positive("مقدار باید بزرگ‌تر از صفر باشد."),
        uomId: z.number().int(),
        remarks: z.string().nullable().optional(),
      })
    )
    .min(1, "لطفاً حداقل یک جنس اضافه کنید."),
});

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
} as const;

export async function GET(request: Request) {
  try {
    const auth = await requireUser();
    if (auth.response) return auth.response;
    // Port isolation: non-admin without an assigned port receives nothing.
    const scopeCheck = requirePortScope(auth.user);
    if (!scopeCheck.ok) return fail(scopeCheck.message, 403);
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const checkpointId = searchParams.get("checkpointId");
    const importerId = searchParams.get("importerId");
    const groupId = searchParams.get("groupId");
    const itemId = searchParams.get("itemId");
    const qRaw = searchParams.get("q")?.trim();
    // Digit variants (Persian/Arabic/Latin) are unified for search — codes
    // and numbers are stored with Latin digits.
    const q = qRaw ? normalizeDigits(qRaw) : null;
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    const hasExceptions = searchParams.get("hasExceptions") === "true";
    const takeParam = Number(searchParams.get("take") ?? 300);
    const take = Math.min(1000, Math.max(1, Number.isFinite(takeParam) ? takeParam : 300));

    const entries = await db.importEntry.findMany({
      where: {
        AND: [
          // Client-supplied checkpoint filters can NEVER widen the scope —
          // port-restricted users are always forced onto their own port.
          scopedCheckpointFilter(auth.user, checkpointId ? Number(checkpointId) : null),
          status ? { status } : {},
          importerId ? { importerId: Number(importerId) } : {},
          // Group filter — every entry recorded by a member of the group.
          groupId ? { importer: { groupId: Number(groupId) } } : {},
          itemId ? { items: { some: { itemId: Number(itemId) } } } : {},
          q ? { entryNumber: { contains: q } } : {},
          from ? { importDatetime: { gte: new Date(from) } } : {},
          to ? { importDatetime: { lte: new Date(to) } } : {},
          hasExceptions ? { items: { some: { exceptionStatus: "PENDING" } } } : {},
        ],
      },
      include: entryInclude,
      orderBy: [{ importDatetime: "desc" }, { id: "desc" }],
      take,
    });
    return ok({ entries });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireUser(["ADMIN", "OFFICER"]);
    if (auth.response) return auth.response;
    const parsed = await readJson(request, entrySchema);
    if (parsed.response) return parsed.response;
    const d = parsed.data;

    // IDEMPOTENT REPLAY: the same request (double-click, retry after a
    // flaky response) returns the originally created record instead of
    // creating another one. Opening the FORM never consumes a number —
    // allocation happens only on the first successful save.
    const replayId = await findIdempotentRecord(db, d.idempotencyKey, "ENTRY");
    if (replayId) {
      const existing = await db.importEntry.findUnique({
        where: { id: replayId },
        include: entryInclude,
      });
      if (existing) {
        const portError = assertPortAccess(auth.user, existing.checkpointId);
        if (portError) return fail(portError, 403);
        return ok({ entry: existing, idempotentReplay: true });
      }
    }

    const importDatetime = new Date(d.importDatetime);
    if (Number.isNaN(importDatetime.getTime())) return fail("تاریخ و ساعت واردات نامعتبر است.");

    // Port isolation on writes: an officer can only register imports for
    // their own assigned port; the client-supplied port ID is never trusted.
    const portError = assertPortAccess(auth.user, d.checkpointId);
    if (portError) return fail(portError, 403);

    // Backdating restricted to authorized users
    if (importDatetime < startOfTodayKabul() && auth.user.role === "OFFICER") {
      return fail("ثبت تاریخ گذشته (بازتاریخ‌گذاری) برای کارمندان ثبت واردات مجاز نیست.");
    }

    const forSubmit = d.action === "submit";
    const result = await db.$transaction(async (tx) => {
      // ONE quota resolution covers every row; the charge is recorded
      // atomically with the finalized registration.
      const prepared = await prepareEntry(
        d.items,
        d.importerId,
        d.checkpointId,
        importDatetime,
        forSubmit,
        tx
      );
      const res = prepared.resolution;
      const entryNumber = await generateEntryNumber(importDatetime, tx);
      const entry = await tx.importEntry.create({
        data: {
          entryNumber,
          importerId: d.importerId,
          checkpointId: d.checkpointId,
          importDatetime,
          vehicleNumber: d.vehicleNumber?.trim() || null,
          remarks: d.remarks?.trim() || null,
          // No approval workflow: a submitted registration is FINAL and
          // consumes the shared quota immediately.
          status: forSubmit ? "APPROVED" : "DRAFT",
          createdBy: auth.user.id,
          ...(forSubmit ? { approvedBy: auth.user.id, approvedAt: new Date() } : {}),
          // ---- Quota charge snapshot (stable history) ----
          // STRICT: within-quota only — the excess columns stay null.
          ...(res
            ? {
                appliedLimitId: res.quota.id,
                quotaSource: res.source,
                chargedGroupId: res.source === "GROUP" ? res.quota.groupId : null,
                chargedGroupName: res.source === "GROUP" ? res.quota.groupName : null,
                quotaUomId: res.quota.uomId,
                quotaChargedQuantity: res.totalCharge,
              }
            : {}),
          items: {
            create: prepared.items.map((p) => ({
              itemId: p.itemId,
              quantity: p.quantity,
              uomId: p.uomId,
              baseQuantity: p.baseQuantity,
              importLimitId: res ? res.quota.id : null,
              // Per-row charge in the quota UOM + applied factor.
              quotaUomQuantity: res ? p.quotaUomQuantity : null,
              quotaConversionFactor: res ? p.quotaConversionFactor : null,
              remarks: p.remarks ?? null,
            })),
          },
        },
        include: entryInclude,
      });

      const actions = [
        { importEntryId: entry.id, actionType: "CREATE", actionBy: auth.user.id, remarks: "ایجاد ثبت واردات" },
      ];
      if (forSubmit) {
        actions.push({
          importEntryId: entry.id,
          actionType: "APPROVE",
          actionBy: auth.user.id,
          remarks:
            res?.source === "GROUP"
              ? `ثبت واردات — حد مجاز گروپ: ${res.quota.groupName ?? ""} (مصرف: ${res.totalCharge} ${res.quota.uomName})`
              : res
                ? `ثبت واردات — حد مجاز فردی (مصرف: ${res.totalCharge} ${res.quota.uomName})`
                : "ثبت واردات",
        });
      }
      await tx.approvalAction.createMany({ data: actions });
      await tx.auditLog.create({
        data: {
          userId: auth.user.id,
          action: "CREATE",
          recordType: "IMPORT_ENTRY",
          recordId: entry.id,
          newValues: JSON.stringify({
            entryNumber,
            status: entry.status,
            items: prepared.items.length,
            ...(res
              ? { quotaSource: res.source, quotaCharged: res.totalCharge, quotaId: res.quota.id }
              : {}),
          }),
        },
      });
      await recordIdempotency(tx, d.idempotencyKey, "ENTRY", entry.id);
      return entry;
    });

    return ok({ entry: result }, 201);
  } catch (e) {
    if (e instanceof ApiError) return fail(e.message);
    return handleApiError(e);
  }
}

