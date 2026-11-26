import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { round3 } from "@/lib/api";
import { periodWindowFor, type PeriodType, formatJalali } from "@/lib/jalali";

export type Tx = Prisma.TransactionClient;

/**
 * "Open-ended" sentinel used for quotas without an end date.
 */
export const MAX_VALID_DATE = new Date("9999-12-31T23:59:59.999Z");

// ============================================================
// Conversions
// ============================================================

/**
 * Convert a row quantity into the ITEM's base UOM (existing behavior).
 */
export async function convertQuantity(
  qty: number,
  fromUomId: number,
  toUomId: number,
  itemId: number,
  tx?: Tx
): Promise<number | null> {
  if (fromUomId === toUomId) return round3(qty);
  const dbx = tx ?? db;
  const conv = await dbx.uomConversion.findFirst({
    where: { itemId, fromUomId, toUomId },
  });
  if (conv && conv.conversionFactor !== 0) return round3(qty * conv.conversionFactor);
  const rev = await dbx.uomConversion.findFirst({
    where: { itemId, fromUomId: toUomId, toUomId: fromUomId },
  });
  if (rev && rev.conversionFactor !== 0) return round3(qty / rev.conversionFactor);
  return null;
}

/**
 * Convert a transaction row into the QUOTA's balance UOM using ONLY
 * configured, approved conversions for that item:
 *   1. direct row-UOM → quota-UOM (or reverse);
 *   2. via the item's base UOM (row→base, base→quota).
 * Density or litre↔tonne factors are NEVER invented.
 */
export async function convertForQuota(
  qty: number,
  rowUomId: number,
  itemId: number,
  quotaUomId: number,
  tx?: Tx
): Promise<{ quantity: number; factor: number | null } | null> {
  if (rowUomId === quotaUomId) return { quantity: round3(qty), factor: null };

  const dbx = tx ?? db;
  const direct = await convertQuantity(qty, rowUomId, quotaUomId, itemId, dbx);
  if (direct !== null) {
    // Factor used = direct conversion (or its inverse).
    const conv = await dbx.uomConversion.findFirst({ where: { itemId, fromUomId: rowUomId, toUomId: quotaUomId } });
    if (conv) return { quantity: direct, factor: conv.conversionFactor };
    const rev = await dbx.uomConversion.findFirst({ where: { itemId, fromUomId: quotaUomId, toUomId: rowUomId } });
    if (rev) return { quantity: direct, factor: 1 / rev.conversionFactor };
    return { quantity: direct, factor: null };
  }

  // Via base UOM (two hops, both configured).
  const item = await dbx.item.findUnique({ where: { id: itemId }, select: { baseUomId: true } });
  if (!item) return null;
  const toBase = await convertQuantity(qty, rowUomId, item.baseUomId, itemId, dbx);
  if (toBase === null) return null;
  const baseToQuota = await convertQuantity(toBase, item.baseUomId, quotaUomId, itemId, dbx);
  if (baseToQuota === null) return null;
  return { quantity: baseToQuota, factor: round3(baseToQuota / qty) };
}

// ============================================================
// Quota usage — the ONE shared-balance calculation used by
// registration, monitoring, profiles, dashboards and reports.
// ============================================================

/** Per-member consumption of ONE group quota — each ACTIVE member owns the
 *  full allowedQuantity as a PERSONAL allowance (member-level cap). */
export interface QuotaMemberConsumption {
  importerId: number;
  name: string;
  importerCode: string;
  membershipStatus: string;
  consumed: number; // this member's stored charges, this window
  remaining: number; // allowedQuantity − consumed (signed)
}

export interface QuotaUsageInfo {
  quotaId: number;
  ownerType: "INDIVIDUAL" | "GROUP";
  importerId: number | null;
  groupId: number | null;
  checkpointId: number;
  /** Record value — for GROUP quotas this is the allowance PER MEMBER. */
  allowedQuantity: number;
  /** GROUP only: active members count. Null for INDIVIDUAL. */
  memberCount: number | null;
  /** GROUP: allowedQuantity × memberCount. INDIVIDUAL: allowedQuantity. */
  totalAllowedQuantity: number;
  /** GROUP only: per-member consumption breakdown. */
  perMemberConsumed: QuotaMemberConsumption[];
  uomId: number;
  uomName: string;
  uomSymbol: string;
  periodType: PeriodType;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  restrictItemId: number | null;
  restrictCategoryId: number | null;
  window: { from: Date; to: Date };
  windowLabel: string;
  consumed: number; // stored charges of ALL members, this window
  remainingSigned: number; // totalAllowed − consumed
  available: number; // max(remainingSigned, 0)
  excess: number; // max(−remainingSigned, 0)
  usagePercent: number | null; // null when no denominator
}

/** Active members of a group — the per-member GROUP quota multiplies by
 *  THIS count (3 members × 50 ℓ = 150 ℓ total group balance). */
async function activeMemberCount(groupId: number, tx?: Tx): Promise<number> {
  const dbx = tx ?? db;
  return dbx.importer.count({ where: { groupId, membershipStatus: "ACTIVE" } });
}

/** Per-member consumption of ONE group quota within a window. Includes
 *  every ACTIVE member (zero rows included) plus anyone who charged the
 *  quota before leaving, so the breakdown is always complete. */
async function groupMemberConsumption(
  quotaId: number,
  groupId: number | null,
  perMemberAllowed: number,
  window: { from: Date; to: Date },
  tx?: Tx
): Promise<QuotaMemberConsumption[]> {
  const dbx = tx ?? db;
  if (!groupId) return [];
  const sums = await dbx.importEntry.groupBy({
    by: ["importerId"],
    where: {
      appliedLimitId: quotaId,
      status: "APPROVED",
      importDatetime: { gte: window.from, lt: window.to },
    },
    _sum: { quotaChargedQuantity: true },
  });
  const consumedBy = new Map(sums.map((s) => [s.importerId, round3(s._sum.quotaChargedQuantity ?? 0)]));
  const consumerIds = [...consumedBy.keys()];
  const people = await dbx.importer.findMany({
    where: consumerIds.length
      ? { OR: [{ groupId }, { id: { in: consumerIds } }] }
      : { groupId },
    select: { id: true, name: true, importerCode: true, membershipStatus: true },
  });
  return people
    .filter((p) => p.membershipStatus === "ACTIVE" || consumedBy.has(p.id))
    .map((p) => {
      const consumed = consumedBy.get(p.id) ?? 0;
      return {
        importerId: p.id,
        name: p.name,
        importerCode: p.importerCode,
        membershipStatus: p.membershipStatus,
        consumed,
        remaining: round3(perMemberAllowed - consumed),
      };
    })
    .sort((a, b) => b.consumed - a.consumed);
}

export function windowForQuota(
  quota: { periodType: string; effectiveFrom: Date; effectiveTo: Date | null },
  date: Date
): { from: Date; to: Date; label: string } {
  if (quota.periodType === "TOTAL") {
    return {
      from: quota.effectiveFrom,
      to: quota.effectiveTo ?? MAX_VALID_DATE,
      label: `کلی (مجموعی) — از ${formatJalali(quota.effectiveFrom)}${quota.effectiveTo ? ` تا ${formatJalali(quota.effectiveTo)}` : ""}`,
    };
  }
  return periodWindowFor(quota.periodType as PeriodType, date);
}

/** Stored-charge consumption for ONE quota within its current window. */
export async function computeQuotaUsage(
  quota: {
    id: number;
    ownerType: string;
    importerId: number | null;
    groupId: number | null;
    checkpointId: number;
    allowedQuantity: number;
    uomId: number;
    periodType: string;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    restrictItemId: number | null;
    restrictCategoryId: number | null;
    uom?: { name: string; symbol: string } | null;
  },
  date: Date,
  tx?: Tx
): Promise<QuotaUsageInfo> {
  const dbx = tx ?? db;
  let uomName = quota.uom?.name ?? "";
  let uomSymbol = quota.uom?.symbol ?? "";
  if (!uomName) {
    const uom = await dbx.uom.findUnique({ where: { id: quota.uomId }, select: { name: true, symbol: true } });
    uomName = uom?.name ?? "";
    uomSymbol = uom?.symbol ?? "";
  }
  const window = windowForQuota(quota, date);
  const agg = await dbx.importEntry.aggregate({
    _sum: { quotaChargedQuantity: true },
    where: {
      appliedLimitId: quota.id,
      status: "APPROVED",
      importDatetime: { gte: window.from, lt: window.to },
    },
  });
  const consumed = round3(agg._sum.quotaChargedQuantity ?? 0);

  // GROUP semantics — allowedQuantity is the PER-MEMBER allowance; the
  // group balance multiplies by the ACTIVE member count.
  const isGroup = quota.ownerType === "GROUP" && quota.groupId != null;
  const memberCount = isGroup ? await activeMemberCount(quota.groupId!, dbx) : null;
  const totalAllowed = isGroup
    ? round3(quota.allowedQuantity * (memberCount ?? 0))
    : quota.allowedQuantity;
  const perMemberConsumed = isGroup
    ? await groupMemberConsumption(quota.id, quota.groupId, quota.allowedQuantity, window, dbx)
    : [];

  const remainingSigned = round3(totalAllowed - consumed);
  return {
    quotaId: quota.id,
    ownerType: quota.ownerType as "INDIVIDUAL" | "GROUP",
    importerId: quota.importerId,
    groupId: quota.groupId,
    checkpointId: quota.checkpointId,
    allowedQuantity: quota.allowedQuantity,
    memberCount,
    totalAllowedQuantity: totalAllowed,
    perMemberConsumed,
    uomId: quota.uomId,
    uomName,
    uomSymbol,
    periodType: quota.periodType as PeriodType,
    effectiveFrom: quota.effectiveFrom,
    effectiveTo: quota.effectiveTo,
    restrictItemId: quota.restrictItemId,
    restrictCategoryId: quota.restrictCategoryId,
    window,
    windowLabel: window.label,
    consumed,
    remainingSigned,
    available: Math.max(0, remainingSigned),
    excess: Math.max(0, -remainingSigned),
    usagePercent: totalAllowed > 0 ? Math.min(999, round3((consumed / totalAllowed) * 100)) : null,
  };
}

/**
 * Batched usage for MANY quotas (monitoring / dashboard / notifications).
 * Grouped by period type so recurring windows need one aggregate each.
 */
export async function computeQuotaUsages(
  quotas: Array<Parameters<typeof computeQuotaUsage>[0]>,
  date: Date
): Promise<Map<number, QuotaUsageInfo>> {
  const out = new Map<number, QuotaUsageInfo>();
  if (!quotas.length) return out;

  // Resolve UOM names in one query.
  const uomIds = Array.from(new Set(quotas.map((q) => q.uomId)));
  const uoms = await db.uom.findMany({ where: { id: { in: uomIds } }, select: { id: true, name: true, symbol: true } });
  const uomMap = new Map(uoms.map((u) => [u.id, u]));

  // Recurring periods share the SAME window for a given date.
  const byRecurring = new Map<string, typeof quotas>();
  const totalQuotas: typeof quotas = [];
  for (const q of quotas) {
    if (q.periodType === "TOTAL") totalQuotas.push(q);
    else {
      const arr = byRecurring.get(q.periodType) ?? [];
      arr.push(q);
      byRecurring.set(q.periodType, arr);
    }
  }

  for (const [periodType, group] of byRecurring) {
    const window = periodWindowFor(periodType as PeriodType, date);
    const ids = group.map((q) => q.id);
    const sums = await db.importEntry.groupBy({
      by: ["appliedLimitId"],
      where: {
        appliedLimitId: { in: ids },
        status: "APPROVED",
        importDatetime: { gte: window.from, lt: window.to },
      },
      _sum: { quotaChargedQuantity: true },
    });
    const sumMap = new Map(sums.map((s) => [s.appliedLimitId, round3(s._sum.quotaChargedQuantity ?? 0)]));

    // GROUP quotas: batch member counts + per-member consumption.
    const groupQuotas = group.filter((q) => q.ownerType === "GROUP" && q.groupId != null);
    const groupIds = [...new Set(groupQuotas.map((q) => q.groupId!))];
    const memberCountByGroup = new Map<number, number>();
    let people: Array<{ id: number; groupId: number | null; name: string; importerCode: string; membershipStatus: string }> = [];
    let memberSums: Array<{ appliedLimitId: number; importerId: number; _sum: { quotaChargedQuantity: number | null } }> = [];
    if (groupQuotas.length > 0) {
      const counts = await db.importer.groupBy({
        by: ["groupId"],
        where: { groupId: { in: groupIds }, membershipStatus: "ACTIVE" },
        _count: { _all: true },
      });
      for (const c of counts) if (c.groupId != null) memberCountByGroup.set(c.groupId, c._count._all);
      const memberSumRows = await db.importEntry.groupBy({
        by: ["appliedLimitId", "importerId"],
        where: {
          appliedLimitId: { in: groupQuotas.map((q) => q.id) },
          status: "APPROVED",
          importDatetime: { gte: window.from, lt: window.to },
        },
        _sum: { quotaChargedQuantity: true },
      });
      memberSums = memberSumRows as unknown as typeof memberSums;
      const consumerIds = [...new Set(memberSumRows.map((s) => s.importerId))];
      people = await db.importer.findMany({
        where: consumerIds.length
          ? { OR: [{ groupId: { in: groupIds } }, { id: { in: consumerIds } }] }
          : { groupId: { in: groupIds } },
        select: { id: true, groupId: true, name: true, importerCode: true, membershipStatus: true },
      });
    }
    const memberChargeKey = (limitId: number, importerId: number) => `${limitId}:${importerId}`;
    const memberChargeMap = new Map(
      memberSums.map((s) => [memberChargeKey(s.appliedLimitId, s.importerId), round3(s._sum.quotaChargedQuantity ?? 0)])
    );

    for (const q of group) {
      const consumed = sumMap.get(q.id) ?? 0;
      const isGroup = q.ownerType === "GROUP" && q.groupId != null;
      const memberCount = isGroup ? (memberCountByGroup.get(q.groupId!) ?? 0) : null;
      const totalAllowed = isGroup
        ? round3(q.allowedQuantity * (memberCount ?? 0))
        : q.allowedQuantity;
      const perMemberConsumed = isGroup
        ? people
            .filter(
              (p) =>
                (p.groupId === q.groupId && p.membershipStatus === "ACTIVE") ||
                memberChargeMap.has(memberChargeKey(q.id, p.id))
            )
            .map((p) => {
              const c = memberChargeMap.get(memberChargeKey(q.id, p.id)) ?? 0;
              return {
                importerId: p.id,
                name: p.name,
                importerCode: p.importerCode,
                membershipStatus: p.membershipStatus,
                consumed: c,
                remaining: round3(q.allowedQuantity - c),
              };
            })
            .sort((a, b) => b.consumed - a.consumed)
        : [];
      const remainingSigned = round3(totalAllowed - consumed);
      out.set(q.id, {
        quotaId: q.id,
        ownerType: q.ownerType as "INDIVIDUAL" | "GROUP",
        importerId: q.importerId,
        groupId: q.groupId,
        checkpointId: q.checkpointId,
        allowedQuantity: q.allowedQuantity,
        memberCount,
        totalAllowedQuantity: totalAllowed,
        perMemberConsumed,
        uomId: q.uomId,
        uomName: uomMap.get(q.uomId)?.name ?? "",
        uomSymbol: uomMap.get(q.uomId)?.symbol ?? "",
        periodType: q.periodType as PeriodType,
        effectiveFrom: q.effectiveFrom,
        effectiveTo: q.effectiveTo,
        restrictItemId: q.restrictItemId,
        restrictCategoryId: q.restrictCategoryId,
        window,
        windowLabel: window.label,
        consumed,
        remainingSigned,
        available: Math.max(0, remainingSigned),
        excess: Math.max(0, -remainingSigned),
        usagePercent: totalAllowed > 0 ? Math.min(999, round3((consumed / totalAllowed) * 100)) : null,
      });
    }
  }

  for (const q of totalQuotas) {
    out.set(q.id, await computeQuotaUsage(q, date));
  }
  return out;
}

// ============================================================
// Quota RESOLUTION for a transaction
//
//   1. An applicable INDIVIDUAL quota takes precedence.
//   2. Otherwise the applicable shared GROUP quota (via the importer's
//      ACTIVE membership, resolved at finalization).
//   3. Neither → the existing no-quota policy.
//
// A quota is APPLICABLE only when it covers EVERY row of the transaction:
// restriction satisfied + a configured conversion to the quota UOM exists.
// Multiple applicable quotas at the same priority = configuration conflict.
// ============================================================

export interface QuotaResolutionRow {
  itemId: number;
  itemName?: string;
  quantity: number;
  uomId: number;
}

export type QuotaResolution =
  | {
      status: "resolved";
      source: "INDIVIDUAL" | "GROUP";
      quota: {
        id: number;
        ownerType: string;
        importerId: number | null;
        groupId: number | null;
        groupName: string | null;
        allowedQuantity: number;
        uomId: number;
        uomName: string;
        uomSymbol: string;
        periodType: string;
        restrictItemId: number | null;
      };
      usage: QuotaUsageInfo;
      /** GROUP only — the REGISTERING member's own allowance state.
       *  A group quota is a PER-MEMBER allowance: enforcement and the
       *  projected remaining are member-level, never the shared pool. */
      memberUsage: {
        importerId: number;
        allowedPerMember: number;
        consumedBefore: number;
        remainingBefore: number;
      } | null;
      /** Per-row charge in quota UOM (stored at finalization). */
      charges: { itemId: number; quantity: number; uomId: number; quotaUomQuantity: number; factor: number | null }[];
      totalCharge: number;
      /** Member-level for GROUP, quota-level for INDIVIDUAL. */
      projectedRemaining: number;
      projectedExcess: number;
      withinQuota: boolean;
    }
  | { status: "missing"; reason: string }
  | { status: "conflict"; reason: string }
  | { status: "incompatible"; reason: string };

export async function resolveQuotaForEntry(
  params: {
    importerId: number;
    checkpointId: number;
    date: Date;
    rows: QuotaResolutionRow[];
    tx?: Tx;
  }
): Promise<QuotaResolution> {
  const { importerId, checkpointId, date, rows, tx } = params;
  const dbx = tx ?? db;

  if (!rows.length) return { status: "missing", reason: "لطفاً حداقل یک جنس برای ثبت واردات اضافه کنید." };

  const importer = await dbx.importer.findUnique({ where: { id: importerId } });
  if (!importer) return { status: "missing", reason: "واردکننده پیدا نشد." };

  // Membership resolved NOW (finalization snapshot).
  let groupId: number | null = null;
  let groupName: string | null = null;
  if (importer.groupId && importer.membershipStatus === "ACTIVE") {
    const g = await dbx.importerGroup.findUnique({
      where: { id: importer.groupId },
      select: { id: true, name: true, status: true },
    });
    if (g && g.status === "ACTIVE") {
      groupId = g.id;
      groupName = g.name;
    }
  }

  const candidateWhere = {
    checkpointId,
    isActive: true,
    effectiveFrom: { lte: date },
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: date } }],
  };

  const evaluate = async (
    candidates: Array<{
      id: number; ownerType: string; importerId: number | null; groupId: number | null;
      checkpointId: number; allowedQuantity: number; uomId: number; periodType: string;
      effectiveFrom: Date; effectiveTo: Date | null;
      restrictItemId: number | null; restrictCategoryId: number | null;
      uom: { name: string; symbol: string };
    }>
  ) => {
    type Evaluated = {
      quota: (typeof candidates)[number];
      charges: {
        itemId: number; quantity: number; uomId: number; quotaUomQuantity: number; factor: number | null;
      }[];
    };
    const applicable: Evaluated[] = [];
    let bestIncompatible: string | null = null;
    for (const q of candidates) {
      let ok = true;
      const charges: Array<{
        itemId: number; quantity: number; uomId: number; quotaUomQuantity: number; factor: number | null;
      }> = [];
      for (const row of rows) {
        // Restriction eligibility.
        if (q.restrictItemId != null && row.itemId !== q.restrictItemId) {
          ok = false;
          bestIncompatible = bestIncompatible ?? `حد مجاز فقط برای جنس مشخص‌شده قابل استفاده است؛ سطر «${row.itemName ?? row.itemId}» شامل آن حد نمی‌شود.`;
          break;
        }
        // Category restriction.
        if (q.restrictCategoryId != null) {
          const it = await dbx.item.findUnique({ where: { id: row.itemId }, select: { categoryId: true } });
          if (!it || it.categoryId !== q.restrictCategoryId) {
            ok = false;
            bestIncompatible = bestIncompatible ?? `حد مجاز فقط برای اجناس دسته مشخص‌شده قابل استفاده است؛ سطر «${row.itemName ?? row.itemId}» شامل آن حد نمی‌شود.`;
            break;
          }
        }
        const conv = await convertForQuota(row.quantity, row.uomId, row.itemId, q.uomId, dbx);
        if (conv === null) {
          ok = false;
          bestIncompatible = bestIncompatible ?? `تبدیل واحد برای سطر «${row.itemName ?? row.itemId}» به واحد حد مجاز تعریف نشده است؛ این سطر نمی‌تواند از این حد مصرف کند.`;
          break;
        }
        charges.push({ itemId: row.itemId, quantity: row.quantity, uomId: row.uomId, quotaUomQuantity: conv.quantity, factor: conv.factor });
      }
      if (ok) applicable.push({ quota: q, charges });
    }
    return { applicable, bestIncompatible };
  };

  // ---------- Priority 1: INDIVIDUAL ----------
  const individualCandidates = await dbx.importLimit.findMany({
    where: { ...candidateWhere, ownerType: "INDIVIDUAL", importerId },
    include: { uom: { select: { name: true, symbol: true } } },
    orderBy: { effectiveFrom: "desc" },
  });
  const indEval = await evaluate(individualCandidates);
  if (indEval.applicable.length === 1) {
    return finalizeResolution(indEval.applicable[0], "INDIVIDUAL", null, importerId, rows, date, dbx);
  }
  if (indEval.applicable.length > 1) {
    return {
      status: "conflict",
      reason: "برای این واردکننده در این بندر بیش از یک حد مجاز فردی قابل استفاده است؛ لطفاً با مدیر سیستم تماس بگیرید تا تداخل حد‌ها رفع شود.",
    };
  }

  // ---------- Priority 2: GROUP (only with ACTIVE membership) ----------
  if (groupId) {
    const groupCandidates = await dbx.importLimit.findMany({
      where: { ...candidateWhere, ownerType: "GROUP", groupId },
      include: { uom: { select: { name: true, symbol: true } } },
      orderBy: { effectiveFrom: "desc" },
    });
    const grpEval = await evaluate(groupCandidates);
    if (grpEval.applicable.length === 1) {
      return finalizeResolution(grpEval.applicable[0], "GROUP", groupName, importerId, rows, date, dbx);
    }
    if (grpEval.applicable.length > 1) {
      return {
        status: "conflict",
        reason: "برای این گروپ در این بندر بیش از یک حد مجاز گروپی قابل استفاده است؛ لطفاً با مدیر سیستم تماس بگیرید تا تداخل حد‌ها رفع شود.",
      };
    }
  }

  // ---------- Nothing applicable ----------
  if (indEval.bestIncompatible || (groupId && false)) {
    return { status: "incompatible", reason: indEval.bestIncompatible! };
  }
  // Group candidates may have failed coverage — surface the best reason.
  if (groupId) {
    const groupCandidates = await dbx.importLimit.findMany({
      where: { ...candidateWhere, ownerType: "GROUP", groupId },
      include: { uom: { select: { name: true, symbol: true } } },
    });
    const grpEval = await evaluate(groupCandidates);
    if (grpEval.bestIncompatible) return { status: "incompatible", reason: grpEval.bestIncompatible };
  }
  return {
    status: "missing",
    reason: groupId
      ? `برای این واردکننده و گروپ «${groupName}» در این بندر حد مجاز فعالی تعریف نشده است. لطفاً با مدیر سیستم تماس بگیرید تا حد مجاز تعیین شود.`
      : "برای این واردکننده در این بندر حد مجاز فعالی تعریف نشده است. لطفاً با مدیر سیستم تماس بگیرید تا حد مجاز تعیین شود.",
  };
}

async function finalizeResolution(
  applicable: { quota: { id: number; ownerType: string; importerId: number | null; groupId: number | null; checkpointId: number; allowedQuantity: number; uomId: number; periodType: string; effectiveFrom: Date; effectiveTo: Date | null; restrictItemId: number | null; restrictCategoryId: number | null; uom: { name: string; symbol: string } }; charges: Array<{ itemId: number; quantity: number; uomId: number; quotaUomQuantity: number; factor: number | null }> },
  source: "INDIVIDUAL" | "GROUP",
  groupName: string | null,
  importerId: number,
  rows: QuotaResolutionRow[],
  date: Date,
  tx?: Tx
): Promise<QuotaResolution> {
  const usage = await computeQuotaUsage(applicable.quota, date, tx);
  const totalCharge = round3(applicable.charges.reduce((s, c) => s + c.quotaUomQuantity, 0));

  // GROUP quota = PER-MEMBER allowance: the registering member is capped
  // at allowedQuantity personally, independent of the other members.
  let memberUsage: {
    importerId: number;
    allowedPerMember: number;
    consumedBefore: number;
    remainingBefore: number;
  } | null = null;
  if (source === "GROUP") {
    const dbx = tx ?? db;
    const agg = await dbx.importEntry.aggregate({
      _sum: { quotaChargedQuantity: true },
      where: {
        appliedLimitId: applicable.quota.id,
        importerId,
        status: "APPROVED",
        importDatetime: { gte: usage.window.from, lt: usage.window.to },
      },
    });
    const consumedBefore = round3(agg._sum.quotaChargedQuantity ?? 0);
    memberUsage = {
      importerId,
      allowedPerMember: applicable.quota.allowedQuantity,
      consumedBefore,
      remainingBefore: round3(applicable.quota.allowedQuantity - consumedBefore),
    };
  }

  const projectedRemaining = round3(
    (memberUsage ? memberUsage.remainingBefore : usage.remainingSigned) - totalCharge
  );
  return {
    status: "resolved",
    source,
    quota: {
      id: applicable.quota.id,
      ownerType: applicable.quota.ownerType,
      importerId: applicable.quota.importerId,
      groupId: applicable.quota.groupId,
      groupName,
      allowedQuantity: applicable.quota.allowedQuantity,
      uomId: applicable.quota.uomId,
      uomName: applicable.quota.uom.name,
      uomSymbol: applicable.quota.uom.symbol,
      periodType: applicable.quota.periodType,
      restrictItemId: applicable.quota.restrictItemId,
    },
    usage,
    memberUsage,
    charges: applicable.charges,
    totalCharge,
    projectedRemaining,
    projectedExcess: Math.max(0, -projectedRemaining),
    withinQuota: projectedRemaining >= 0,
  };
}

// ============================================================
// One active quota per (owner, port, UOM) — the item is no longer
// part of the quota identity. Enforced by the create/update routes.
// ============================================================

export async function findOverlappingQuota(
  params: {
    ownerType: "INDIVIDUAL" | "GROUP";
    importerId: number | null;
    groupId: number | null;
    checkpointId: number;
    uomId: number;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    excludeId?: number;
    tx?: Tx;
  },
  tx?: Tx
) {
  const dbx = tx ?? db;
  const ownerWhere =
    params.ownerType === "INDIVIDUAL"
      ? { ownerType: "INDIVIDUAL", importerId: params.importerId }
      : { ownerType: "GROUP", groupId: params.groupId };
  return dbx.importLimit.findFirst({
    where: {
      ...ownerWhere,
      checkpointId: params.checkpointId,
      uomId: params.uomId,
      isActive: true,
      id: params.excludeId ? { not: params.excludeId } : undefined,
      effectiveFrom: { lte: params.effectiveTo ?? MAX_VALID_DATE },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: params.effectiveFrom } }],
    },
    include: {
      importer: { select: { name: true, importerCode: true } },
      group: { select: { name: true, code: true } },
      uom: { select: { name: true, symbol: true } },
    },
  });
}
