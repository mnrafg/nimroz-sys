import { db } from "@/lib/db";
import { computeQuotaUsages } from "@/lib/quota";
import {
  formatJalali,
  formatJalaliDateTime,
  formatNumber,
  toJalali,
  startOfTodayKabul,
  kabulParts,
  kabulDateToUtc,
  JALALI_MONTHS,
  type PeriodType,
} from "@/lib/jalali";
import { toJalaali as j2jDate, toGregorian as j2gDate } from "jalaali-js";
import {
  ENTRY_STATUS_LABELS,
  EXCEPTION_STATUS_LABELS,
  PERIOD_LABELS,
  REPORT_TYPE_LABELS,
} from "@/lib/constants";

export interface ReportColumn {
  key: string;
  label: string;
  type?: "number" | "text";
}

export interface ReportData {
  type: string;
  title: string;
  columns: ReportColumn[];
  rows: Record<string, string | number>[];
  summary: Record<string, string | number>[];
  meta: {
    from?: string;
    to?: string;
    checkpointName?: string;
    importerName?: string;
    groupName?: string;
    itemName?: string;
    asOf?: string;
    generatedBy: string;
    generatedAt: string;
  };
}

/**
 * Server-side default date windows per report type — a "daily" report can
 * never silently become an unrestricted multi-month list.
 */
export function defaultWindowFor(type: string): { from: Date; to: Date; defaulted: boolean; label: string } {
  const todayStart = startOfTodayKabul();
  const p = kabulParts(todayStart);
  const todayEnd = kabulDateToUtc(p.y, p.m, p.d + 1);
  if (type === "daily") {
    return { from: todayStart, to: todayEnd, defaulted: true, label: "امروز (به وقت کابل)" };
  }
  if (type === "monthly") {
    // Current Solar Hijri month boundaries (Asia/Kabul).
    const j = j2jDate(
      kabulParts(todayStart).y,
      kabulParts(todayStart).m,
      kabulParts(todayStart).d
    );
    const gFrom = j2gDate(j.jy, j.jm, 1);
    const njy = j.jm === 12 ? j.jy + 1 : j.jy;
    const njm = j.jm === 12 ? 1 : j.jm + 1;
    const gTo = j2gDate(njy, njm, 1);
    const from = kabulDateToUtc(gFrom.gy, gFrom.gm, gFrom.gd);
    const to = kabulDateToUtc(gTo.gy, gTo.gm, gTo.gd);
    return {
      from,
      to,
      defaulted: true,
      label: `${JALALI_MONTHS[j.jm - 1]} ${j.jy} (ماه جاری هجری شمسی)`,
    };
  }
  return { from: todayStart, to: todayEnd, defaulted: false, label: "" };
}

export interface ReportFilters {
  from?: Date | null;
  to?: Date | null;
  checkpointId?: number | null;
  importerId?: number | null;
  /** Group filter — entries of the group's members (and, for the quota
   *  report, the group's OWN shared balance as well). */
  groupId?: number | null;
  itemId?: number | null;
  q?: string | null;
  /** Explicit "as of" instant for the remaining-quota report. */
  asOf?: Date | null;
  /** Exception report: include rows of canceled (REVERSED) entries. */
  includeReversed?: boolean;
  /**
   * V14 fix — registry visibility `where` for meta-name lookups. Port users
   * only see names of importers within their registry scope; admins see all.
   * `null` = caller has no registry access (meta names hidden entirely).
   */
  importerVisibility?: Record<string, unknown> | null;
}

function itemsSummary(items: Array<{ quantity: number; uom: { symbol: string }; item: { itemName: string } }>): string {
  return items
    .map((i) => `${i.item.itemName}: ${formatNumber(i.quantity)} ${i.uom.symbol}`)
    .join("، ");
}

/**
 * Aggregates entry-item rows (already normalized to the item's BASE UOM via
 * baseQuantity) into per-جنس totals so month/checkpoint reports can show
 * WHICH goods moved — not just how many records were created.
 */
function addItemTotals(
  map: Map<string, { qty: number; uom: string }>,
  rows: Array<{ baseQuantity: number; item: { itemName: string; baseUom: { name: string } } }>
): void {
  for (const it of rows) {
    const cur = map.get(it.item.itemName);
    if (cur) cur.qty = Math.round((cur.qty + it.baseQuantity) * 1000) / 1000;
    else map.set(it.item.itemName, { qty: Math.round(it.baseQuantity * 1000) / 1000, uom: it.item.baseUom.name });
  }
}

function itemTotalsLabel(items: Map<string, { qty: number; uom: string }>): string {
  return [...items.entries()]
    .map(([name, { qty, uom }]) => `${name}: ${formatNumber(qty)} ${uom}`)
    .join("، ");
}

/** Shared `items` select for month/checkpoint aggregation in base UOM. */
const ITEM_TOTALS_SELECT = {
  baseQuantity: true,
  item: { select: { itemName: true, baseUom: { select: { name: true } } } },
} as const;

function inRange(
  d: Date,
  from: Date | null | undefined,
  to: Date | null | undefined
): boolean {
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

export async function buildReport(
  type: string,
  filters: ReportFilters,
  userName: string
): Promise<ReportData> {
  let { from, to, checkpointId, importerId, groupId, itemId, q, importerVisibility } = filters;

  // SERVER-SIDE DEFAULTS: daily → today (Kabul); monthly → current Solar
  // Hijri month. Callers may still pass explicit windows.
  const defaultWindow = defaultWindowFor(type);
  if (defaultWindow.defaulted && !from && !to) {
    from = defaultWindow.from;
    to = defaultWindow.to;
  }
  // Range sanity: `to` is inclusive of its business day.
  if (to && from && to < from) {
    const tmp = from;
    from = to;
    to = tmp;
  }

  const entryWhere = {
    AND: [
      from || to
        ? { importDatetime: { gte: from ?? undefined, lte: to ?? undefined } }
        : {},
      checkpointId ? { checkpointId } : {},
      importerId ? { importerId } : {},
      // Group filter — every entry recorded by a member of the group.
      groupId ? { importer: { groupId } } : {},
      itemId ? { items: { some: { itemId } } } : {},
      q ? { OR: [{ entryNumber: { contains: q } }, { remarks: { contains: q } }] } : {},
    ],
  };

  const entryInclude = {
    importer: { select: { name: true, companyName: true, importerCode: true } },
    checkpoint: { select: { name: true, province: true } },
    creator: { select: { name: true } },
    approver: { select: { name: true } },
    items: {
      include: {
        item: { select: { itemName: true, itemCode: true, baseUomId: true, baseUom: { select: { name: true, symbol: true } } } },
        uom: { select: { symbol: true, name: true } },
      },
    },
  } as const;

  const meta: ReportData["meta"] = {
    generatedBy: userName,
    generatedAt: formatJalaliDateTime(new Date()),
  };
  if (from) meta.from = formatJalali(from);
  if (to) meta.to = formatJalali(to);
  if (checkpointId) {
    const cp = await db.borderCheckpoint.findUnique({ where: { id: checkpointId } });
    meta.checkpointName = cp?.name;
  }
  if (importerId) {
    // V14 fix — the importer name in the report header is only resolved
    // when the caller's registry scope includes that importer.
    const imp = await db.importer.findFirst({
      where: {
        id: importerId,
        ...(importerVisibility === null ? { id: -1 } : (importerVisibility as object)),
      },
    });
    meta.importerName = imp ? `${imp.name} (${imp.companyName ?? "—"})` : undefined;
  }
  if (groupId) {
    const grp = await db.importerGroup.findUnique({ where: { id: groupId } });
    meta.groupName = grp ? `${grp.name} (${grp.code})` : undefined;
  }
  if (itemId) {
    const item = await db.item.findUnique({ where: { id: itemId } });
    meta.itemName = item?.itemName;
  }

  // ---------- 1. Daily import report ----------
  if (type === "daily") {
    const [entries, totalCount, approvedTotal, reversedTotal] = await Promise.all([
      db.importEntry.findMany({
        where: entryWhere,
        include: entryInclude,
        orderBy: { importDatetime: "asc" },
        take: 2000,
      }),
      // Summary numbers use ALL matching records — never just the page.
      db.importEntry.count({ where: entryWhere }),
      db.importEntry.count({ where: { AND: [entryWhere, { status: "APPROVED" }] } }),
      db.importEntry.count({ where: { AND: [entryWhere, { status: "REVERSED" }] } }),
    ]);
    const rows = entries.map((e) => ({
      entryNumber: e.entryNumber,
      date: formatJalali(e.importDatetime),
      time: formatJalaliDateTime(e.importDatetime).split(" ساعت ")[1] ?? "",
      importer: `${e.importer.name} (${e.importer.companyName ?? "—"})`,
      checkpoint: e.checkpoint.name,
      items: itemsSummary(e.items as never),
      status: ENTRY_STATUS_LABELS[e.status] ?? e.status,
      createdBy: e.creator?.name ?? "—",
    }));
    return {
      type,
      title: REPORT_TYPE_LABELS[type],
      columns: [
        { key: "entryNumber", label: "نمبر ثبت" },
        { key: "date", label: "تاریخ" },
        { key: "time", label: "ساعت" },
        { key: "importer", label: "واردکننده" },
        { key: "checkpoint", label: "بندر" },
        { key: "items", label: "اجناس" },
        { key: "status", label: "وضعیت" },
        { key: "createdBy", label: "ثبت‌کننده" },
      ],
      rows,
      summary: [
        { label: "مجموع ثبت‌ها", value: totalCount },
        { label: "ثبت‌شده", value: approvedTotal },
        { label: "ابطال‌شده", value: reversedTotal },
      ],
      meta,
    };
  }

  // ---------- 2. Monthly import report ----------
  if (type === "monthly") {
    const [entries, totalCount] = await Promise.all([
      db.importEntry.findMany({
        where: entryWhere,
        select: {
          importDatetime: true,
          status: true,
          items: { select: ITEM_TOTALS_SELECT },
        },
        orderBy: { importDatetime: "asc" },
        take: 20000,
      }),
      db.importEntry.count({ where: entryWhere }),
    ]);
    const groups = new Map<string, { label: string; total: number; approved: number; draft: number; reversed: number; items: Map<string, { qty: number; uom: string }> }>();
    for (const e of entries) {
      if (!inRange(e.importDatetime, from, to)) continue;
      const j = toJalali(e.importDatetime);
      const key = `${j.jy}-${String(j.jm).padStart(2, "0")}`;
      if (!groups.has(key)) {
        groups.set(key, {
          label: `${JALALI_MONTHS[j.jm - 1]} ${j.jy}`,
          total: 0,
          approved: 0,
          draft: 0,
          reversed: 0,
          items: new Map(),
        });
      }
      const g = groups.get(key)!;
      g.total++;
      if (e.status === "APPROVED") {
        g.approved++;
        // جنس breakdown — quantities of APPROVED entries, in each item's base UOM.
        addItemTotals(g.items, e.items);
      } else if (e.status === "DRAFT") g.draft++;
      else if (e.status === "REVERSED") g.reversed++;
    }
    const rows = [...groups.values()].map((g) => ({
      month: g.label,
      total: g.total,
      approved: g.approved,
      reversed: g.reversed,
      items: g.items.size > 0 ? itemTotalsLabel(g.items) : "",
    }));
    return {
      type,
      title: REPORT_TYPE_LABELS[type],
      columns: [
        { key: "month", label: "ماه (تقویم هجری شمسی)" },
        { key: "total", label: "مجموع ثبت‌ها", type: "number" },
        { key: "approved", label: "ثبت‌شده", type: "number" },
        { key: "reversed", label: "ابطال‌شده", type: "number" },
        { key: "items", label: "اجناس تأییدشده" },
      ],
      rows,
      summary: [
        { label: "مجموع ثبت‌ها", value: totalCount },
      ],
      meta,
    };
  }

  // ---------- 3. Importer-wise report ----------
  if (type === "importer") {
    const itemWhere = {
      importEntry: {
        status: "APPROVED",
        AND: [
          from || to ? { importDatetime: { gte: from ?? undefined, lte: to ?? undefined } } : {},
          checkpointId ? { checkpointId } : {},
          importerId ? { importerId } : {},
          groupId ? { importer: { groupId } } : {},
        ],
      },
      ...(itemId ? { itemId } : {}),
    };
    const entryItems = await db.importEntryItem.findMany({
      where: itemWhere,
      include: {
        item: { include: { baseUom: true } },
        importEntry: { include: { importer: true, checkpoint: true } },
      },
      take: 5000,
    });
    const groups = new Map<string, { importer: string; company: string; itemName: string; uom: string; count: number; qty: number }>();
    for (const it of entryItems) {
      const key = `${it.importEntry.importerId}-${it.itemId}`;
      if (!groups.has(key)) {
        groups.set(key, {
          importer: it.importEntry.importer.name,
          company: it.importEntry.importer.companyName ?? "—",
          itemName: it.item.itemName,
          uom: it.item.baseUom.name,
          count: 0,
          qty: 0,
        });
      }
      const g = groups.get(key)!;
      g.count++;
      g.qty = Math.round((g.qty + it.baseQuantity) * 1000) / 1000;
    }
    const rows = [...groups.values()].map((g) => ({
      importer: g.importer,
      company: g.company,
      item: g.itemName,
      qty: g.qty,
      uom: g.uom,
      count: g.count,
    }));
    return {
      type,
      title: REPORT_TYPE_LABELS[type],
      columns: [
        { key: "importer", label: "واردکننده" },
        { key: "company", label: "شرکت" },
        { key: "item", label: "جنس" },
        { key: "qty", label: "مجموع مقدار تأییدشده", type: "number" },
        { key: "uom", label: "واحد اساس" },
        { key: "count", label: "تعداد ثبت‌ها", type: "number" },
      ],
      rows,
      summary: [{ label: "مجموع سطرها", value: rows.length }],
      meta,
    };
  }

  // ---------- 4. Item-wise report ----------
  if (type === "item") {
    const itemWhere = {
      importEntry: {
        status: "APPROVED",
        AND: [
          from || to ? { importDatetime: { gte: from ?? undefined, lte: to ?? undefined } } : {},
          checkpointId ? { checkpointId } : {},
          importerId ? { importerId } : {},
          groupId ? { importer: { groupId } } : {},
        ],
      },
      ...(itemId ? { itemId } : {}),
    };
    const entryItems = await db.importEntryItem.findMany({
      where: itemWhere,
      include: {
        item: { include: { baseUom: true } },
        importEntry: { select: { id: true } },
      },
      take: 5000,
    });
    const groups = new Map<number, { itemName: string; itemCode: string; uom: string; count: number; qty: number }>();
    for (const it of entryItems) {
      if (!groups.has(it.itemId)) {
        groups.set(it.itemId, {
          itemName: it.item.itemName,
          itemCode: it.item.itemCode,
          uom: it.item.baseUom.name,
          count: 0,
          qty: 0,
        });
      }
      const g = groups.get(it.itemId)!;
      g.count++;
      g.qty = Math.round((g.qty + it.baseQuantity) * 1000) / 1000;
    }
    const rows = [...groups.values()].map((g) => ({
      item: g.itemName,
      itemCode: g.itemCode,
      qty: g.qty,
      uom: g.uom,
      count: g.count,
    }));
    return {
      type,
      title: REPORT_TYPE_LABELS[type],
      columns: [
        { key: "item", label: "جنس" },
        { key: "itemCode", label: "کود جنس" },
        { key: "qty", label: "مجموع مقدار تأییدشده", type: "number" },
        { key: "uom", label: "واحد اساس" },
        { key: "count", label: "تعداد ثبت‌ها", type: "number" },
      ],
      rows,
      summary: [{ label: "مجموع اجناس", value: rows.length }],
      meta,
    };
  }

  // ---------- 5. Checkpoint-wise report ----------
  if (type === "checkpoint") {
    const entries = await db.importEntry.findMany({
      where: entryWhere,
      select: {
        checkpointId: true,
        checkpoint: { select: { name: true, province: true } },
        status: true,
        items: { select: ITEM_TOTALS_SELECT },
      },
      take: 5000,
    });
    const groups = new Map<number, { name: string; province: string; total: number; approved: number; reversed: number; items: Map<string, { qty: number; uom: string }> }>();
    for (const e of entries) {
      if (!groups.has(e.checkpointId)) {
        groups.set(e.checkpointId, {
          name: e.checkpoint.name,
          province: e.checkpoint.province,
          total: 0,
          approved: 0,
          reversed: 0,
          items: new Map(),
        });
      }
      const g = groups.get(e.checkpointId)!;
      g.total++;
      if (e.status === "APPROVED") {
        g.approved++;
        // جنس breakdown — WHICH goods crossed this checkpoint (base UOM).
        addItemTotals(g.items, e.items);
      } else if (e.status === "REVERSED") g.reversed++;
    }
    const rows = [...groups.values()].map((g) => ({
      checkpoint: g.name,
      province: g.province,
      total: g.total,
      approved: g.approved,
      reversed: g.reversed,
      items: g.items.size > 0 ? itemTotalsLabel(g.items) : "",
    }));
    return {
      type,
      title: REPORT_TYPE_LABELS[type],
      columns: [
        { key: "checkpoint", label: "بندر" },
        { key: "province", label: "ولایت" },
        { key: "total", label: "مجموع ثبت‌ها", type: "number" },
        { key: "approved", label: "ثبت‌شده", type: "number" },
        { key: "reversed", label: "ابطال‌شده", type: "number" },
        { key: "items", label: "اجناس تأییدشده" },
      ],
      rows,
      summary: [{ label: "مجموع ثبت‌ها", value: entries.length }],
      meta,
    };
  }

  // ---------- 6. Remaining quota report (owner-based balances; GROUP =
  // per-member allowances — the pool multiplies by active members) ----------
  if (type === "remaining_quota") {
    const limits = await db.importLimit.findMany({
      where: {
        isActive: true,
        AND: [
          importerId ? { importerId } : {},
          checkpointId ? { checkpointId } : {},
          // Group filter — the group's OWN shared balance AND the individual
          // balances of its members, in one view.
          groupId ? { OR: [{ groupId }, { importer: { groupId } }] } : {},
        ],
      },
      include: {
        importer: { select: { name: true, companyName: true, importerCode: true } },
        group: { select: { name: true, code: true } },
        checkpoint: { select: { name: true } },
        restrictItem: { select: { itemName: true } },
        uom: true,
      },
      orderBy: [{ checkpointId: "asc" }, { importerId: "asc" }, { groupId: "asc" }],
      take: 1000,
    });
    // Explicit "as of" instant — defaults to NOW in Asia/Kabul and is
    // displayed in the report meta so printed figures are unambiguous.
    const asOf = filters.asOf ?? new Date();
    meta.asOf = formatJalaliDateTime(asOf);
    // Batched: stored-charge usage for every quota in ONE pass — the SAME
    // engine used by monitoring, registration, profiles and dashboard.
    const usageMap = await computeQuotaUsages(limits, asOf);
    // Per-جنس consumption breakdown — each row's STORED quota-UOM charge
    // (quotaUomQuantity snapshot at finalization), grouped per quota and
    // filtered to the quota's CURRENT window. Legacy rows without a stored
    // charge cannot be attributed and are never reconstructed.
    const limitIds = limits.map((l) => l.id);
    const consumptionByQuota = new Map<number, Map<string, number>>();
    if (limitIds.length > 0) {
      const chargeRows = await db.importEntryItem.findMany({
        where: { importLimitId: { in: limitIds }, importEntry: { status: "APPROVED" } },
        select: {
          importLimitId: true,
          quotaUomQuantity: true,
          item: { select: { itemName: true } },
          importEntry: { select: { importDatetime: true } },
        },
      });
      for (const r of chargeRows) {
        if (r.importLimitId === null || r.quotaUomQuantity === null) continue;
        const usage = usageMap.get(r.importLimitId);
        if (!usage) continue;
        const d = r.importEntry.importDatetime;
        if (d < usage.window.from || d >= usage.window.to) continue;
        let m = consumptionByQuota.get(r.importLimitId);
        if (!m) {
          m = new Map();
          consumptionByQuota.set(r.importLimitId, m);
        }
        m.set(
          r.item.itemName,
          Math.round(((m.get(r.item.itemName) ?? 0) + r.quotaUomQuantity) * 1000) / 1000
        );
      }
    }
    const rows: Record<string, string | number>[] = [];
    for (const lim of limits) {
      const usage = usageMap.get(lim.id);
      if (!usage) continue;
      const ownerLabel =
        lim.ownerType === "GROUP"
          ? `گروپ: ${lim.group?.name ?? "—"}`
          : `${lim.importer?.name ?? "—"} (${lim.importer?.companyName ?? "—"})`;
      const consumedItems = consumptionByQuota.get(lim.id);
      const itemsConsumed =
        consumedItems && consumedItems.size > 0
          ? [...consumedItems.entries()]
              .map(([name, qty]) => `${name}: ${formatNumber(qty)} ${lim.uom.symbol}`)
              .join("، ")
          : "";
      rows.push({
        ownerType: lim.ownerType === "GROUP" ? "گروپی" : "فردی",
        owner: ownerLabel,
        checkpoint: lim.checkpoint.name,
        restriction: lim.restrictItem?.itemName ?? "همه اجناس مجاز",
        itemsConsumed,
        period: PERIOD_LABELS[lim.periodType],
        // GROUP: the PER-MEMBER allowance (each active member owns it).
        allowed: formatNumber(lim.allowedQuantity),
        allowedUom: lim.uom.name,
        members: lim.ownerType === "GROUP" ? (usage.memberCount ?? 0) : 1,
        totalAllowed: formatNumber(usage.totalAllowedQuantity),
        consumed: formatNumber(usage.consumed),
        remaining: formatNumber(usage.available),
        excess: usage.excess > 0 ? formatNumber(usage.excess) : 0,
        usage: usage.usagePercent ?? 0,
      });
    }
    return {
      type,
      title: REPORT_TYPE_LABELS[type],
      columns: [
        { key: "ownerType", label: "نوع حد" },
        { key: "owner", label: "صاحب حد" },
        { key: "checkpoint", label: "بندر" },
        { key: "restriction", label: "محدودیت اجناس" },
        { key: "itemsConsumed", label: "اجناس مصرف‌شده" },
        { key: "period", label: "مدت حد" },
        { key: "allowed", label: "حد هر عضو", type: "number" },
        { key: "allowedUom", label: "واحد" },
        { key: "members", label: "تعداد اعضا", type: "number" },
        { key: "totalAllowed", label: "مجموع حد مجاز", type: "number" },
        { key: "consumed", label: "مصرف‌شده", type: "number" },
        { key: "remaining", label: "باقی‌مانده", type: "number" },
        { key: "excess", label: "مقدار اضافی", type: "number" },
        { key: "usage", label: "درصد استفاده", type: "number" },
      ],
      rows,
      summary: [{ label: "مجموع حد‌های فعال", value: rows.length }],
      meta,
    };
  }

  // ---------- 7. Exception (over-quota) report — recorded with reason ----------
  if (type === "exception") {
    // Canceled records are EXCLUDED by default; inclusion is an explicit,
    // labeled choice (includeReversed=1) — never a silent mix.
    const includeReversed = filters.includeReversed === true;
    const statusFilter = includeReversed
      ? {}
      : { status: { not: "REVERSED" } };
    const itemWhere = {
      OR: [{ exceptionStatus: "PENDING" }, { exceptionStatus: "APPROVED" }, { exceptionStatus: "REJECTED" }],
      importEntry: {
        AND: [
          from || to ? { importDatetime: { gte: from ?? undefined, lte: to ?? undefined } } : {},
          checkpointId ? { checkpointId } : {},
          importerId ? { importerId } : {},
          groupId ? { importer: { groupId } } : {},
          statusFilter,
        ],
      },
    };
    const items = await db.importEntryItem.findMany({
      where: itemWhere,
      include: {
        item: { select: { itemName: true } },
        uom: { select: { symbol: true } },
        importEntry: {
          include: {
            importer: { select: { name: true, companyName: true } },
            checkpoint: { select: { name: true } },
          },
        },
        exceptionRequester: { select: { name: true } },
        exceptionApprover: { select: { name: true } },
        exceptionRejecter: { select: { name: true } },
      },
      orderBy: { id: "desc" },
      take: 2000,
    });
    const rows = items.map((it) => ({
      entryNumber: it.importEntry.entryNumber,
      importDate: formatJalali(it.importEntry.importDatetime),
      importer: `${it.importEntry.importer.name} (${it.importEntry.importer.companyName ?? "—"})`,
      checkpoint: it.importEntry.checkpoint.name,
      item: it.item.itemName,
      quantity: `${formatNumber(it.quantity)} ${it.uom.symbol}`,
      // Original excess recorded AT FINALIZATION — historical rows without
      // a stored amount show "—"; values are never reconstructed/guessed.
      excess: it.approvedExcessQuantity !== null && it.approvedExcessQuantity !== undefined ? formatNumber(it.approvedExcessQuantity) : "—",
      reason: it.exceptionReason ?? "—",
      requestedBy: it.exceptionRequester?.name ?? "—",
      // Legacy rows (PENDING/REJECTED) come from the retired approval
      // workflow and are labeled as such.
      status:
        (EXCEPTION_STATUS_LABELS[it.exceptionStatus ?? ""] ?? "—") +
        (it.exceptionStatus === "PENDING" || it.exceptionStatus === "REJECTED" ? " (سابقه)" : ""),
      decidedBy: it.exceptionApprover?.name ?? it.exceptionRejecter?.name ?? "—",
    }));
    return {
      type,
      title: REPORT_TYPE_LABELS[type],
      columns: [
        { key: "entryNumber", label: "نمبر ثبت" },
        { key: "importDate", label: "تاریخ واردات" },
        { key: "importer", label: "واردکننده" },
        { key: "checkpoint", label: "بندر" },
        { key: "item", label: "جنس" },
        { key: "quantity", label: "مقدار ثبت‌شده" },
        { key: "excess", label: "مقدار اضافی" },
        { key: "reason", label: "دلیل" },
        { key: "requestedBy", label: "ثبت‌کننده" },
        { key: "status", label: "وضعیت" },
        { key: "decidedBy", label: "تأییدکننده" },
      ],
      rows,
      summary: [
        { label: "مجموع موارد", value: rows.length },
        { label: "تأییدشده", value: items.filter((i) => i.exceptionStatus === "APPROVED").length },
        { label: "در انتظار تصمیم (سابقه)", value: items.filter((i) => i.exceptionStatus === "PENDING").length },
        { label: "ردشده (سابقه)", value: items.filter((i) => i.exceptionStatus === "REJECTED").length },
      ],
      meta,
    };
  }

  throw new Error("نوع گزارش نامعتبر است.");
}
