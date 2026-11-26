import { db } from "@/lib/db";
import { fail, handleApiError, ok, requireUser, round3 } from "@/lib/api";
import { computeQuotaUsages, MAX_VALID_DATE } from "@/lib/quota";
import { requirePortScope, scopedCheckpointFilter } from "@/lib/scope";

/**
 * GET /api/limits/monitoring?health=near|exhausted|exceeded|expired|scheduled|active|ok|missing
 *                            &ownerType=INDIVIDUAL|GROUP &importerId=&groupId=&checkpointId=
 *
 * REAL operational monitoring over owner-based quotas — the SAME
 * stored-charge calculation used by registration:
 *   remaining_signed = total_allowed − finalized consumption
 *   available        = max(remaining_signed, 0)
 *   excess           = max(−remaining_signed, 0)
 *
 * GROUP quotas are PER-MEMBER: `allowedQuantity` is each member's personal
 * allowance, the group balance multiplies by the ACTIVE member count, and
 * every member is capped individually.
 *
 * `missing` lists active importers / groups WITHOUT any active quota at
 * a port (the gap an officer would discover only at registration time).
 */
export async function GET(request: Request) {
  try {
    const auth = await requireUser();
    if (auth.response) return auth.response;
    const scopeCheck = requirePortScope(auth.user);
    if (!scopeCheck.ok) return fail(scopeCheck.message, 403);
    const { searchParams } = new URL(request.url);
    const health = searchParams.get("health") ?? "all";
    const status = searchParams.get("status") ?? "active";
    const ownerType = searchParams.get("ownerType");
    const importerId = searchParams.get("importerId") ? Number(searchParams.get("importerId")) : null;
    const groupId = searchParams.get("groupId") ? Number(searchParams.get("groupId")) : null;
    const requestedCheckpointId = searchParams.get("checkpointId") ? Number(searchParams.get("checkpointId")) : null;
    const asOfParam = searchParams.get("asOf");
    const asOf = asOfParam && !Number.isNaN(new Date(asOfParam).getTime()) ? new Date(asOfParam) : new Date();

    const cpFilter = scopedCheckpointFilter(auth.user, requestedCheckpointId);

    // ---------- Special filter: MISSING quotas ----------
    if (health === "missing") {
      const since = new Date(asOf.getTime() - 30 * 86400000);
      const activeQuotas = await db.importLimit.findMany({
        where: {
          AND: [cpFilter, { isActive: true }, { effectiveFrom: { lte: asOf } }],
        },
        select: { ownerType: true, importerId: true, groupId: true, checkpointId: true },
      });
      const indCovered = new Set(activeQuotas.filter((q) => q.ownerType === "INDIVIDUAL").map((q) => `${q.importerId}:${q.checkpointId}`));
      const grpCovered = new Set(activeQuotas.filter((q) => q.ownerType === "GROUP").map((q) => `${q.groupId}:${q.checkpointId}`));

      // Importers ACTIVE at this port in the last 30 days.
      const entryRows = await db.importEntry.findMany({
        where: {
          AND: [cpFilter, { status: "APPROVED" }, { importDatetime: { gte: since } }],
        },
        select: {
          importerId: true,
          checkpointId: true,
          importer: { select: { id: true, name: true, importerCode: true, importerType: true, groupId: true, membershipStatus: true, group: { select: { id: true, name: true, code: true } } } },
        },
        distinct: ["importerId", "checkpointId"],
        take: 300,
      });
      const missing: Record<string, unknown>[] = [];
      for (const r of entryRows) {
        const hasIndividual = indCovered.has(`${r.importerId}:${r.checkpointId}`);
        const groupEligible = r.importer.membershipStatus === "ACTIVE" && r.importer.groupId;
        const hasGroup = groupEligible && grpCovered.has(`${r.importer.groupId}:${r.checkpointId}`);
        if (!hasIndividual && !hasGroup) {
          missing.push({
            key: `imp:${r.importerId}:${r.checkpointId}`,
            ownerType: "INDIVIDUAL",
            importer: {
              id: r.importer.id,
              name: r.importer.name,
              importerCode: r.importer.importerCode,
              importerType: r.importer.importerType,
            },
            group: groupEligible ? r.importer.group : null,
            checkpointId: r.checkpointId,
          });
        }
      }
      return ok({ rows: missing.slice(0, 100), missing: true });
    }

    // ---------- Standard quota monitoring ----------
    const limits = await db.importLimit.findMany({
      where: {
        AND: [
          status === "active" ? { isActive: true } : status === "inactive" ? { isActive: false } : {},
          ownerType ? { ownerType } : {},
          importerId ? { importerId } : {},
          groupId ? { groupId } : {},
          cpFilter,
        ],
      },
      include: {
        importer: { select: { id: true, name: true, companyName: true, importerCode: true, importerType: true, status: true, groupId: true } },
        group: {
          select: {
            id: true, name: true, code: true,
            representative: { select: { id: true, name: true, importerCode: true } },
            _count: { select: { members: { where: { membershipStatus: "ACTIVE" } } } },
          },
        },
        checkpoint: { select: { id: true, name: true, province: true } },
        restrictItem: { select: { itemName: true, itemCode: true } },
        restrictCategory: { select: { name: true } },
        uom: { select: { name: true, symbol: true } },
        creator: { select: { name: true } },
      },
      orderBy: [{ checkpointId: "asc" }, { importerId: "asc" }, { groupId: "asc" }],
      take: 500,
    });

    const usageMap = await computeQuotaUsages(limits, asOf);

    const rows = limits.map((limit) => {
      const usage = usageMap.get(limit.id);
      const effectiveFromOk = limit.effectiveFrom <= asOf;
      const effectiveToOk = !limit.effectiveTo || limit.effectiveTo >= asOf;
      const validity = !effectiveFromOk ? "scheduled" : effectiveToOk ? "valid" : "expired";

      let healthState: "ok" | "near" | "exhausted" | "exceeded" | "no_data" = "no_data";
      if (usage) {
        if (usage.remainingSigned < 0) healthState = "exceeded";
        else if (usage.usagePercent !== null && usage.usagePercent >= 100) healthState = "exhausted";
        else if (usage.usagePercent !== null && usage.usagePercent >= 80) healthState = "near";
        else healthState = "ok";
      }

      return {
        id: limit.id,
        ownerType: limit.ownerType,
        importer: limit.importer,
        group: limit.group,
        checkpoint: limit.checkpoint,
        restriction:
          limit.restrictItem
            ? { kind: "item" as const, label: limit.restrictItem.itemName }
            : limit.restrictCategory
              ? { kind: "category" as const, label: limit.restrictCategory.name }
              : null,
        periodType: limit.periodType,
        allowedQuantity: limit.allowedQuantity,
        uom: { name: limit.uom.name, symbol: limit.uom.symbol },
        effectiveFrom: limit.effectiveFrom,
        effectiveTo: limit.effectiveTo,
        isActive: limit.isActive,
        creator: limit.creator?.name ?? null,
        validity,
        health: healthState,
        quota: usage
          ? {
              allowedBaseQuantity: usage.allowedQuantity,
              // GROUP semantics: allowance is PER MEMBER; the group pool
              // multiplies by the ACTIVE member count.
              memberCount: usage.memberCount,
              totalAllowedQuantity: usage.totalAllowedQuantity,
              memberBreakdown: usage.perMemberConsumed,
              consumedBaseQuantity: usage.consumed,
              availableBaseQuantity: usage.available,
              excessBaseQuantity: usage.excess,
              usagePercent: usage.usagePercent,
              windowLabel: usage.windowLabel,
            }
          : null,
        nextBoundary: usage ? usage.window.to.toISOString() : (limit.effectiveTo ?? MAX_VALID_DATE).toISOString(),
      };
    });

    const filtered =
      health === "all"
        ? rows
        : rows.filter((r) => {
            if (health === "expired") return r.validity === "expired";
            if (health === "scheduled") return r.validity === "scheduled";
            if (health === "active") return r.validity === "valid" && r.isActive;
            return r.health === health;
          });

    return ok({ rows: filtered, asOf: asOf.toISOString() });
  } catch (e) {
    return handleApiError(e);
  }
}
