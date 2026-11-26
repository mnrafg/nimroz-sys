import { db } from "@/lib/db";
import { fail, handleApiError, ok, requireUser, round3 } from "@/lib/api";
import {
  kabulParts,
  kabulDateToUtc,
  startOfTodayKabul,
  formatJalali,
} from "@/lib/jalali";
import { computeQuotaUsages, type QuotaUsageInfo } from "@/lib/quota";
import { getAutomationSettings } from "@/lib/settings";
import { portScopeFor, scopedCheckpointFilter, requirePortScope } from "@/lib/scope";

export async function GET(request: Request) {
  try {
    const auth = await requireUser();
    if (auth.response) return auth.response;
    const { searchParams } = new URL(request.url);
    const fromParam = searchParams.get("from");
    const toParam = searchParams.get("to");
    const requestedCheckpointId = searchParams.get("checkpointId") ? Number(searchParams.get("checkpointId")) : null;
    const importerId = searchParams.get("importerId") ? Number(searchParams.get("importerId")) : null;
    // Group filter — entries recorded by members of the selected group.
    const groupId = searchParams.get("groupId") ? Number(searchParams.get("groupId")) : null;
    const itemId = searchParams.get("itemId") ? Number(searchParams.get("itemId")) : null;
    const trendDays = Math.min(120, Math.max(1, Number(searchParams.get("days") ?? 30) || 30));

    // Port isolation: a non-admin without an assigned port receives NO
    // operational data. The requested port filter is honored only for admins —
    // it can NEVER override a port-restricted user's assignment.
    const scopeCheck = requirePortScope(auth.user);
    if (!scopeCheck.ok) return fail(scopeCheck.message, 403);
    const scope = portScopeFor(auth.user);
    const automation = await getAutomationSettings();
    const nearThreshold = automation.quotaAlertThresholdPercent;

    // Default date window: today (Kabul)
    const todayStart = startOfTodayKabul();
    const p = kabulParts(todayStart);
    const todayEnd = kabulDateToUtc(p.y, p.m, p.d + 1);
    const customRange = Boolean(fromParam || toParam);
    const from = fromParam ? new Date(fromParam) : todayStart;
    const to = toParam ? new Date(toParam) : todayEnd;

    const cpFilter = scopedCheckpointFilter(auth.user, requestedCheckpointId);

    // Checkpoint-only filter — NO date window, NO importer/item narrowing.
    // Counts that must always agree with the approvals / entries views use
    // THIS filter: a PENDING entry submitted yesterday is still actionable
    // today and must never show as zero on the dashboard.
    const cpOnlyWhere = { AND: [cpFilter] };

    const rangeWhere = {
      AND: [
        cpFilter,
        importerId ? { importerId } : {},
        // Group filter narrows everything below to the group's members.
        groupId ? { importer: { groupId } } : {},
        itemId ? { items: { some: { itemId } } } : {},
      ],
    };

    const rangeWhereDate = {
      AND: [
        { importDatetime: { gte: from, lte: to } },
        rangeWhere,
      ],
    };

    // ---------- Analytics window (trend, rankings, composition) ----------
    // Custom range → exactly [from, to]. Default (no explicit range) → the
    // LAST `trendDays` days ending at the current Kabul-day end, so the
    // trend, rankings and composition still show history when "today" has
    // no entries yet. KPI cards keep their "today" semantics.
    const analyticsFrom = customRange
      ? from
      : new Date(to.getTime() - trendDays * 86400000 + 1000);
    const analyticsWhere = {
      AND: [{ importDatetime: { gte: analyticsFrom, lte: to } }, rangeWhere],
    };

    // "today" is always the Asia/Kabul day — a custom from/to window narrows
    // the range metrics but never redefines what "today" means.
    const todayWhere = {
      AND: [{ importDatetime: { gte: todayStart, lte: todayEnd } }, rangeWhere],
    };

    // Label of the applied window (surfaced to the dashboard range chip).
    const rangeLabel = customRange
      ? `از ${formatJalali(from)} تا ${formatJalali(to)}`
      : "امروز (به وقت کابل)";

    // Importers "within the authorized scope": for a port user, importers
    // active at that port (having limits or entries there); for admin, all.
    const scopedImporterWhere = {
      status: "ACTIVE" as const,
      ...(scope.kind === "port"
        ? {
            OR: [
              { limits: { some: { checkpointId: scope.checkpointId } } },
              { entries: { some: { checkpointId: scope.checkpointId } } },
            ],
          }
        : {}),
    };

    const [
      todayEntries,
      approvedCount,
      reversedCount,
      draftCount,
      importersCount,
      activePortsCount,
      activeQuotaGroups,
      recentEntries,
      checkpointBreakdown,
      statusBreakdown,
      membershipBreakdown,
      groupsCount,
    ] = await Promise.all([
      // "today" metric — fixed Asia/Kabul day window (NOT the custom range).
      db.importEntry.count({ where: todayWhere }),
      // ثبت‌شده — range-scoped (it is a range metric).
      db.importEntry.count({ where: { ...rangeWhereDate, status: "APPROVED" } }),
      // ابطال‌شده — checkpoint filter ONLY (no date window).
      db.importEntry.count({ where: { AND: [cpFilter, { status: "REVERSED" }] } }),
      // مسوده — checkpoint filter ONLY.
      db.importEntry.count({ where: { AND: [cpFilter, { status: "DRAFT" }] } }),
      db.importer.count({ where: scopedImporterWhere }),
      db.borderCheckpoint.count({
        where:
          scope.kind === "port"
            ? { status: "ACTIVE", id: scope.checkpointId }
            : { status: "ACTIVE" },
      }),
      // Owner-type breakdown of active quotas — INDIVIDUAL (one importer,
      // one balance) vs GROUP (one SHARED balance for all members).
      db.importLimit.groupBy({
        by: ["ownerType"],
        where: { isActive: true, effectiveFrom: { lte: new Date() }, ...(cpFilter as object) },
        _count: { id: true },
      }),
      // Recent entries — latest 6 by importDatetime with ONLY the checkpoint
      // filter (date window dropped) so the list agrees with the entries view.
      db.importEntry.findMany({
        where: cpOnlyWhere,
        include: {
          importer: { select: { name: true, companyName: true, importerCode: true } },
          checkpoint: { select: { name: true } },
          creator: { select: { name: true } },
          items: {
            include: {
              item: { select: { itemName: true, baseUom: { select: { symbol: true } } } },
              uom: { select: { symbol: true } },
            },
          },
        },
        orderBy: { importDatetime: "desc" },
        take: 6,
      }),
      db.importEntry.groupBy({
        by: ["checkpointId"],
        where: { ...analyticsWhere, status: "APPROVED" },
        _count: { id: true },
      }),
      // Status distribution over the analytics window — drives the dashboard
      // composition donut (ثبت‌شده / مسوده / ابطال‌شده).
      db.importEntry.groupBy({
        by: ["status"],
        where: analyticsWhere,
        _count: { id: true },
      }),
      // Group-vs-individual membership split of approved entries — how much
      // of the port's activity flows through organized border-worker groups.
      db.importEntry.groupBy({
        by: ["importerId"],
        where: { ...analyticsWhere, status: "APPROVED" },
        _count: { id: true },
      }),
      db.importerGroup.count({ where: { status: "ACTIVE" } }),
    ]);

    // Port comparison is nationwide data — visible to admins only. Port
    // users get a single-item breakdown for their own port.
    const checkpoints = await db.borderCheckpoint.findMany({
      where: { status: "ACTIVE", ...(scope.kind === "port" ? { id: scope.checkpointId } : {}) },
      select: { id: true, name: true },
    });
    const breakdown = checkpoints.map((cp) => ({
      name: cp.name,
      count: checkpointBreakdown.find((b) => b.checkpointId === cp.id)?._count.id ?? 0,
    }));

    // ---------- Membership split (group vs individual activity) ----------
    // Resolve each active importer's membership ONCE, then split counts.
    const memberImporterIds = membershipBreakdown.map((m) => m.importerId);
    const membershipRows = memberImporterIds.length
      ? await db.importer.findMany({
          where: { id: { in: memberImporterIds } },
          select: { id: true, groupId: true },
        })
      : [];
    let groupEntries = 0;
    let individualEntries = 0;
    for (const m of membershipBreakdown) {
      const inGroup = membershipRows.find((r) => r.id === m.importerId)?.groupId != null;
      if (inGroup) groupEntries += m._count.id;
      else individualEntries += m._count.id;
    }

    // ---------- Status distribution (selected window) ----------
    const statusCounts: Record<string, number> = {};
    for (const s of statusBreakdown) statusCounts[s.status] = s._count.id;

    // ---------- Trend (approved entries per Kabul day) ----------
    const trendRows = await db.importEntry.findMany({
      where: analyticsWhere,
      select: { importDatetime: true, status: true },
      take: 6000,
    });
    const trendMap = new Map<string, { label: string; approved: number; total: number }>();
    for (const row of trendRows) {
      const kp = kabulParts(row.importDatetime);
      const key = `${kp.y}-${String(kp.m).padStart(2, "0")}-${String(kp.d).padStart(2, "0")}`;
      const bucket = trendMap.get(key) ?? {
        label: formatJalali(row.importDatetime),
        approved: 0,
        total: 0,
      };
      bucket.total += 1;
      if (row.status === "APPROVED") bucket.approved += 1;
      trendMap.set(key, bucket);
    }
    const trend: { label: string; approved: number; total: number }[] = Array.from(
      trendMap.entries()
    )
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(({ label, approved, total }) => ({ label, approved, total }));

    // ---------- Top items (approved entry count — no UOM mixing) ----------
    const topItemGroups = await db.importEntryItem.groupBy({
      by: ["itemId"],
      where: {
        importEntry: { ...analyticsWhere, status: "APPROVED" },
      },
      _count: { id: true },
    });
    const topItemIds = topItemGroups
      .sort((a, b) => b._count.id - a._count.id)
      .slice(0, 8);
    const topItemRows = topItemIds.length
      ? await db.item.findMany({
          where: { id: { in: topItemIds.map((t) => t.itemId) } },
          select: { id: true, itemName: true },
        })
      : [];
    const topItems = topItemIds
      .map((t) => ({
        name: topItemRows.find((r) => r.id === t.itemId)?.itemName ?? "—",
        count: t._count.id,
      }))
      .filter((t) => t.name !== "—");

    // ---------- Most active importers ----------
    const importerGroups = await db.importEntry.groupBy({
      by: ["importerId"],
      where: { ...analyticsWhere, status: "APPROVED" },
      _count: { id: true },
      _max: { importDatetime: true },
    });
    const topImporterGroups = importerGroups
      .sort((a, b) => b._count.id - a._count.id)
      .slice(0, 8);
    const importerIds = topImporterGroups.map((g) => g.importerId);
    const importerRows = importerIds.length
      ? await db.importer.findMany({
          where: { id: { in: importerIds } },
          select: { id: true, name: true, companyName: true },
        })
      : [];
    const lastEntries = importerIds.length
      ? await db.importEntry.findMany({
          where: {
            importerId: { in: importerIds },
            status: "APPROVED",
            // Port isolation: the "last import" hint must never reveal an
            // importer's activity at OTHER ports to a port-restricted user.
            ...(scope.kind === "port" ? { checkpointId: scope.checkpointId } : {}),
          },
          include: { checkpoint: { select: { name: true } } },
          orderBy: { importDatetime: "desc" },
          take: importerIds.length * 3,
        })
      : [];
    const topImporters = topImporterGroups.map((g) => {
      const last = lastEntries.find((e) => e.importerId === g.importerId);
      const imp = importerRows.find((r) => r.id === g.importerId);
      return {
        name: imp?.name ?? "—",
        companyName: imp?.companyName ?? null,
        count: g._count.id,
        lastImportDate: g._max.importDatetime ?? null,
        lastPort: last?.checkpoint.name ?? null,
      };
    });

    // ---------- Quota alerts (owner-based quotas, current window) ----------
    // Batched: ONE pass computes every active quota's usage. GROUP quotas
    // are PER-MEMBER — the alert compares group consumption against the
    // TOTAL pool (per-member allowance × active members).
    const activeLimits = await db.importLimit.findMany({
      where: {
        isActive: true,
        effectiveFrom: { lte: new Date() },
        ...(cpFilter as object),
      },
      include: {
        importer: { select: { name: true, status: true } },
        group: { select: { name: true } },
        checkpoint: { select: { name: true } },
        uom: { select: { name: true, symbol: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: 200,
    });
    const usageMap = await computeQuotaUsages(activeLimits, new Date());

    const quotaAlerts: {
      id: number;
      ownerType: string;
      owner: string;
      port: string;
      uom: string;
      periodType: string;
      /** GROUP: per-member allowance × members. INDIVIDUAL: the allowance. */
      allowed: number;
      allowedPerMember: number | null;
      memberCount: number | null;
      approved: number;
      remaining: number;
      percent: number;
      status: "ok" | "near" | "exhausted" | "exceeded";
    }[] = [];

    for (const limit of activeLimits) {
      if (limit.importer && limit.importer.status !== "ACTIVE") continue;
      const usage: QuotaUsageInfo | undefined = usageMap.get(limit.id);
      if (!usage) continue;
      const allowed = usage.totalAllowedQuantity;
      const approved = usage.consumed;
      const rawRemaining = usage.remainingSigned;
      const remaining = Math.max(0, rawRemaining);
      const percent = usage.usagePercent ?? 0;
      const status =
        rawRemaining < 0
          ? "exceeded"
          : approved >= allowed
            ? "exhausted"
            : percent >= nearThreshold
              ? "near"
              : "ok";
      quotaAlerts.push({
        id: limit.id,
        ownerType: limit.ownerType,
        owner:
          limit.ownerType === "GROUP"
            ? `گروپ: ${limit.group?.name ?? "—"}`
            : limit.importer?.name ?? "—",
        port: limit.checkpoint.name,
        uom: limit.uom.symbol,
        periodType: limit.periodType,
        allowed: round3(allowed),
        allowedPerMember: limit.ownerType === "GROUP" ? round3(usage.allowedQuantity) : null,
        memberCount: usage.memberCount,
        approved: round3(approved),
        remaining: round3(remaining),
        percent,
        status,
      });
    }
    quotaAlerts.sort((a, b) => {
      const order = { exceeded: 0, exhausted: 1, near: 2, ok: 3 } as const;
      return order[a.status] - order[b.status] || b.percent - a.percent;
    });
    const completedLimits = quotaAlerts.filter(
      (q) => q.status === "exhausted" || q.status === "exceeded"
    ).length;

    // ---------- Recent activity (recorded approval actions) ----------
    const actions = await db.approvalAction.findMany({
      where: { importEntry: { ...rangeWhere } },
      include: {
        actor: { select: { name: true } },
        importEntry: { select: { entryNumber: true } },
      },
      orderBy: { actionAt: "desc" },
      take: 12,
    });
    const recentActivity = actions.map((a) => ({
      id: a.id,
      actionType: a.actionType,
      remarks: a.remarks,
      actor: a.actor.name,
      entryNumber: a.importEntry.entryNumber,
      actionAt: a.actionAt.toISOString(),
    }));

    // ---------- Total imported quantity, grouped by compatible UOM ----------
    // Approved entry items in range, normalized into each item's BASE UOM,
    // then summed per UOM — incompatible units are never mixed.
    const qtyRows = await db.importEntryItem.findMany({
      where: { importEntry: { ...analyticsWhere, status: "APPROVED" } },
      select: { baseQuantity: true, item: { select: { baseUom: { select: { id: true, name: true, symbol: true } } } } },
    });
    const uomMap = new Map<number, { name: string; symbol: string; total: number }>();
    for (const r of qtyRows) {
      const key = r.item.baseUom.id;
      const bucket = uomMap.get(key) ?? { name: r.item.baseUom.name, symbol: r.item.baseUom.symbol, total: 0 };
      bucket.total = round3(bucket.total + r.baseQuantity);
      uomMap.set(key, bucket);
    }
    const importedByUom = Array.from(uomMap.values()).sort((a, b) => b.total - a.total);

    return ok({
      stats: {
        todayEntries,
        approvedCount,
        reversedCount,
        draftCount,
        importersCount,
        activePortsCount,
        activeQuotas: activeQuotaGroups.reduce((s, g) => s + g._count.id, 0),
        individualQuotas: activeQuotaGroups.find((g) => g.ownerType === "INDIVIDUAL")?._count.id ?? 0,
        groupQuotas: activeQuotaGroups.find((g) => g.ownerType === "GROUP")?._count.id ?? 0,
        nearLimitQuotas: quotaAlerts.filter((q) => q.status !== "ok").length,
        completedLimits,
        importedByUom,
      },
      dateWindow: { from, to },
      range: { from: from.toISOString(), to: to.toISOString(), label: rangeLabel },
      recentEntries: recentEntries.map((e) => ({
        id: e.id,
        entryNumber: e.entryNumber,
        importDatetime: e.importDatetime,
        status: e.status,
        importerName: e.importer.name,
        companyName: e.importer.companyName,
        checkpointName: e.checkpoint.name,
        createdBy: e.creator?.name ?? "—",
        items: e.items.map((i) => ({
          itemName: i.item.itemName,
          quantity: i.quantity,
          uom: i.uom.symbol,
        })),
      })),
      checkpointBreakdown: breakdown,
      statusCounts,
      membership: { groupEntries, individualEntries },
      groupsCount,
      trend,
      topItems,
      topImporters,
      quotaAlerts: quotaAlerts.slice(0, 40),
      recentActivity,
      lastUpdated: new Date().toISOString(),
    });
  } catch (e) {
    return handleApiError(e);
  }
}
