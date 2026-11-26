import { db } from "@/lib/db";
import { round3 } from "@/lib/api";
import { resolveQuotaForEntry, type QuotaResolutionRow, type Tx } from "@/lib/quota";

export class ApiError extends Error {}

export interface EntryItemPayload {
  itemId: number;
  quantity: number;
  uomId: number;
  remarks?: string | null;
}

export interface PreparedEntry {
  /** Quota resolved for the WHOLE transaction (individual > group).
   *  Null for DRAFTS — drafts never consume quota. */
  resolution: Extract<
    Awaited<ReturnType<typeof resolveQuotaForEntry>>,
    { status: "resolved" }
  > | null;
  items: PreparedItem[];
}

export interface PreparedItem {
  itemId: number;
  itemName: string;
  quantity: number;
  uomId: number;
  /** Stored legacy normalization (item base UOM) for display. */
  baseQuantity: number;
  importLimitId: number | null;
  /** Charge of THIS row against the quota UOM + the factor applied. */
  quotaUomQuantity: number;
  quotaConversionFactor: number | null;
  remarks: string | null;
}

/**
 * Resolve the ONE applicable quota for the transaction and compute the
 * charge of every row against the quota's shared balance.
 *
 *  - QUOTA IS TOTAL-QUANTITY BASED: all eligible rows are converted to the
 *    quota UOM and charged against ONE balance (diesel 30 + petrol 20 = 50
 *    litre quota → one balance, never two).
 *  - INDIVIDUAL quota takes precedence over the GROUP quota; a transaction
 *    never consumes both.
 *  - Group membership is resolved AT FINALIZATION and stored with the
 *    transaction (later membership changes never rewrite history).
 *  - STRICT QUOTA ENFORCEMENT: a transaction whose total charge exceeds the
 *    remaining balance is REJECTED — registration beyond the quota limit is
 *    never permitted (no reason path, no approval, no exceptions). GROUP
 *    quotas are PER-MEMBER: the registering member's own allowance is the
 *    binding balance, never the pooled group total.
 */
export async function prepareEntry(
  payloadItems: EntryItemPayload[],
  importerId: number,
  checkpointId: number,
  importDatetime: Date,
  forSubmit: boolean,
  tx?: Tx
): Promise<PreparedEntry> {
  const dbx = tx ?? db;

  if (!payloadItems.length) {
    throw new ApiError("لطفاً حداقل یک جنس برای ثبت واردات اضافه کنید.");
  }

  // Validate items + build resolution rows (base quantities kept for display).
  const rows: QuotaResolutionRow[] = [];
  const baseQuantities = new Map<number, number>();
  const itemNames = new Map<number, string>();

  for (const it of payloadItems) {
    const item = await dbx.item.findUnique({
      where: { id: it.itemId },
      include: { baseUom: true },
    });
    if (!item || item.status !== "ACTIVE") {
      throw new ApiError("یکی از اجناس انتخاب‌شده غیرفعال یا ناموجود است.");
    }
    if (!it.quantity || it.quantity <= 0) {
      throw new ApiError(`مقدار جنس «${item.itemName}» باید بزرگ‌تر از صفر باشد.`);
    }
    rows.push({ itemId: it.itemId, itemName: item.itemName, quantity: it.quantity, uomId: it.uomId });
    itemNames.set(it.itemId, item.itemName);

    // Base quantity for the item-wise display (existing semantics).
    let base: number | null = it.uomId === item.baseUomId ? round3(it.quantity) : null;
    if (base === null) {
      const conv = await dbx.uomConversion.findFirst({
        where: { itemId: it.itemId, fromUomId: it.uomId, toUomId: item.baseUomId },
      });
      if (conv) base = round3(it.quantity * conv.conversionFactor);
      else {
        const rev = await dbx.uomConversion.findFirst({
          where: { itemId: it.itemId, fromUomId: item.baseUomId, toUomId: it.uomId },
        });
        if (rev) base = round3(it.quantity / rev.conversionFactor);
      }
    }
    if (base === null) {
      throw new ApiError(
        `تبدیل واحد برای جنس «${item.itemName}» تعریف نشده است؛ لطفاً ضریب تبدیل را در بخش واحدات تعریف کنید.`
      );
    }
    baseQuantities.set(it.itemId, base);
  }

  // Resolve the ONE quota covering every row (individual > group).
  const resolution = await resolveQuotaForEntry({
    importerId,
    checkpointId,
    date: importDatetime,
    rows,
    tx,
  });

  if (!forSubmit) {
    // DRAFTS do not consume quota and do not require one — a private,
    // recoverable stage that never affects the shared balance.
    return {
      resolution: null,
      items: payloadItems.map((it) => ({
        itemId: it.itemId,
        itemName: itemNames.get(it.itemId) ?? "",
        quantity: it.quantity,
        uomId: it.uomId,
        baseQuantity: baseQuantities.get(it.itemId) ?? 0,
        importLimitId: null,
        quotaUomQuantity: 0,
        quotaConversionFactor: null,
        remarks: it.remarks?.trim() || null,
      })),
    };
  }

  if (resolution.status === "conflict") {
    throw new ApiError(resolution.reason);
  }
  if (resolution.status === "incompatible") {
    throw new ApiError(resolution.reason);
  }
  if (resolution.status === "missing") {
    throw new ApiError(resolution.reason);
  }

  // ---- STRICT QUOTA ENFORCEMENT: exceeding the limit is NEVER allowed.
  // The total charge of all rows must fit within the remaining balance —
  // there is no reason path, no approval and no exception.
  // GROUP quotas are PER-MEMBER: the registering member's own remaining
  // allowance is the binding balance (other members never cover it). ----
  if (resolution.projectedExcess > 0) {
    const memberLimited = resolution.source === "GROUP" && resolution.memberUsage;
    const available = memberLimited ? resolution.memberUsage!.remainingBefore : resolution.usage.available;
    const scopeLabel = memberLimited ? "باقی‌مانده سهمیه این عضو" : "باقی‌مانده حد مجاز";
    throw new ApiError(
      `ثبت واردات بیش از حد مجاز مجاز نیست. ${scopeLabel}: ${available} ${resolution.quota.uomName} — مقدار درخواستی: ${resolution.totalCharge} ${resolution.quota.uomName} — مقدار اضافی: ${resolution.projectedExcess} ${resolution.quota.uomName}. لطفاً مقدار اجناس را تا حداکثر باقی‌مانده (${available} ${resolution.quota.uomName}) کاهش دهید و مقدار اضافی را در ثبت بعدی (بعد از تمدید سهمیه) ثبت کنید.`
    );
  }

  const chargeByItem = new Map<number, { q: number; factor: number | null }>();
  for (const c of resolution.charges) {
    chargeByItem.set(c.itemId, { q: c.quotaUomQuantity, factor: c.factor });
  }

  return {
    resolution,
    items: payloadItems.map((it) => ({
      itemId: it.itemId,
      itemName: itemNames.get(it.itemId) ?? "",
      quantity: it.quantity,
      uomId: it.uomId,
      baseQuantity: baseQuantities.get(it.itemId) ?? 0,
      importLimitId: resolution.quota.id,
      quotaUomQuantity: chargeByItem.get(it.itemId)?.q ?? 0,
      quotaConversionFactor: chargeByItem.get(it.itemId)?.factor ?? null,
      remarks: it.remarks?.trim() || null,
    })),
  };
}

/** Generate the next sequential entry number for a Solar Hijri year.
 *  Backed by the durable SequenceCounter — numbers of deleted drafts or
 *  canceled entries are NEVER reused. */
export async function generateEntryNumber(importDatetime: Date, tx: Tx): Promise<string> {
  const { toJalali } = await import("@/lib/jalali");
  const { allocateNumber, maxNumericSuffix } = await import("@/lib/sequences");
  const jy = toJalali(importDatetime).jy;
  const prefix = `IMP-${jy}-`;
  const existing = await tx.importEntry.findMany({
    where: { entryNumber: { startsWith: prefix } },
    select: { entryNumber: true },
  });
  const seedFrom = maxNumericSuffix(existing.map((e) => e.entryNumber), prefix);
  return allocateNumber(tx, `ENTRY:${jy}`, {
    prefix,
    pad: 5,
    seedFrom,
    exists: async (candidate) => {
      const hit = await tx.importEntry.findUnique({ where: { entryNumber: candidate }, select: { id: true } });
      return Boolean(hit);
    },
  });
}
