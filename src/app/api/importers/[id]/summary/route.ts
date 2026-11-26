import { db } from "@/lib/db";
import { fail, requireUser, ok, handleApiError } from "@/lib/api";
import { computeQuotaUsages } from "@/lib/quota";
import { startOfTodayKabul } from "@/lib/jalali";
import { portScopeFor, canViewImporter, importerScopeEvidence, NO_PORT_MESSAGE, CROSS_PORT_MESSAGE } from "@/lib/scope";

/**
 * GET /api/importers/[id]/summary?from&to
 *
 * Authenticated importer profile + quota status + import history.
 * All data comes from the EXISTING ImportLimit / ImportEntry tables —
 * no duplicated history records are created. Quota math reuses the
 * existing quota engine (per importer × checkpoint × item, APPROVED only).
 * Operational data (quotas/history) is PORT-SCOPED for non-admins; the
 * importer master identity itself stays centralized.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireUser();
    if (auth.response) return auth.response;
    // Quotas, today-totals and history are OPERATIONAL data — a non-admin
    // without an assigned port receives none of them.
    const scope = portScopeFor(auth.user);
    if (scope.kind === "none") return fail(NO_PORT_MESSAGE, 403);
    const { id } = await params;
    const importerId = Number(id);
    if (!Number.isFinite(importerId)) return ok({ error: "شناسه واردکننده نامعتبر است." }, 400);

    const { searchParams } = new URL(request.url);
    const fromParam = searchParams.get("from");
    const toParam = searchParams.get("to");

    const importer = await db.importer.findUnique({
      where: { id: importerId },
      include: {
        ...importerScopeEvidence,
        group: {
          select: {
            id: true,
            code: true,
            name: true,
            status: true,
            representative: { select: { id: true, name: true, importerCode: true } },
          },
        },
        subgroup: { select: { id: true, code: true, name: true } },
      },
    });
    if (!importer) return ok({ error: "واردکننده مورد نظر پیدا نشد." }, 404);
    // V4 fix — registry identity is only served within the caller's scope.
    if (!canViewImporter(auth.user, importer)) {
      return fail(CROSS_PORT_MESSAGE, 403);
    }
    const importerWithEvidence = importer;

    const scopeCheck = portScopeFor(auth.user);
    const portFilter =
      scopeCheck.kind === "port" ? { checkpointId: scopeCheck.checkpointId } : {};
    const {
      photoData: _photo,
      entries: _evEntries,
      limits: _evLimits,
      ...rest
    } = importerWithEvidence;

    // ---- Applicable quotas: INDIVIDUAL (own) + GROUP (via ACTIVE
    // membership) — the importer sees both sources; registration resolves
    // individual first. ----
    const now = new Date();
    const individualLimits = await db.importLimit.findMany({
      where: {
        ownerType: "INDIVIDUAL",
        importerId,
        isActive: true,
        effectiveFrom: { lte: now },
        ...(portFilter as object),
      },
      include: {
        checkpoint: { select: { id: true, name: true } },
        uom: { select: { name: true, symbol: true } },
        restrictItem: { select: { itemName: true } },
      },
      orderBy: [{ checkpointId: "asc" }],
    });
    const groupLimits = importerWithEvidence.group && importerWithEvidence.group.status === "ACTIVE" && importer.membershipStatus === "ACTIVE"
      ? await db.importLimit.findMany({
          where: {
            ownerType: "GROUP",
            groupId: importerWithEvidence.group.id,
            isActive: true,
            effectiveFrom: { lte: now },
            ...(portFilter as object),
          },
          include: {
            checkpoint: { select: { id: true, name: true } },
            uom: { select: { name: true, symbol: true } },
            restrictItem: { select: { itemName: true } },
          },
          orderBy: [{ checkpointId: "asc" }],
        })
      : [];

    const allQuotas = [...individualLimits.map((l) => ({ ...l, source: "INDIVIDUAL" as const })), ...groupLimits.map((l) => ({ ...l, source: "GROUP" as const }))];
    const usageMap = await computeQuotaUsages(allQuotas, now);
    const quotas = allQuotas.map((limit) => {
      const usage = usageMap.get(limit.id);
      const isGroup = limit.source === "GROUP";
      // GROUP quota = PER-MEMBER allowance — the member's own numbers are
      // what registration enforces, so the profile surfaces them directly.
      const memberRow = isGroup && usage
        ? usage.perMemberConsumed.find((m) => m.importerId === importerId) ?? null
        : null;
      return {
        limitId: limit.id,
        source: limit.source,
        groupName: isGroup ? importerWithEvidence.group?.name ?? null : null,
        checkpoint: limit.checkpoint,
        periodType: limit.periodType,
        allowedQuantity: limit.allowedQuantity,
        uomSymbol: limit.uom.symbol,
        restriction: limit.restrictItem?.itemName ?? null,
        windowLabel: usage?.windowLabel ?? null,
        allowedBaseQuantity: usage?.allowedQuantity ?? null,
        approvedBaseQuantity: usage?.consumed ?? null,
        remainingBaseQuantity: usage?.available ?? null,
        overQuota: (usage?.excess ?? 0) > 0,
        conversionError: false,
        // Per-member view (GROUP only):
        perMember: isGroup,
        memberCount: usage?.memberCount ?? null,
        totalAllowedQuantity: usage?.totalAllowedQuantity ?? null,
        memberConsumed: memberRow ? memberRow.consumed : isGroup ? 0 : null,
        memberRemaining: memberRow
          ? memberRow.remaining
          : isGroup
            ? limit.allowedQuantity
            : null,
      };
    });

    // ---- Today snapshot (Asia/Kabul business day) — port-scoped ----
    const todayStart = startOfTodayKabul();
    const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
    const todayWhere = {
      importerId,
      status: "APPROVED" as const,
      importDatetime: { gte: todayStart, lt: todayEnd },
      ...(portFilter as object),
    };
    const [todayAgg, todayEntriesCount, lastEntry] = await Promise.all([
      db.importEntryItem.aggregate({
        _sum: { baseQuantity: true },
        where: { importEntry: todayWhere },
      }),
      db.importEntry.count({ where: todayWhere }),
      db.importEntry.findFirst({
        where: { importerId, status: "APPROVED", ...(portFilter as object) },
        orderBy: { importDatetime: "desc" },
        select: { importDatetime: true, checkpoint: { select: { name: true } } },
      }),
    ]);
    const todayApprovedBase = todayAgg._sum.baseQuantity ?? 0;

    // ---- History window (default: last 30 days) — from existing entries only ----
    const to = toParam ? new Date(toParam) : now;
    const from = fromParam
      ? new Date(fromParam)
      : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    const entries =
      scopeCheck.kind === "none"
        ? []
        : await db.importEntry.findMany({
            where: {
              importerId,
              importDatetime: { gte: from, lte: to },
              ...(portFilter as object),
            },
            include: {
              checkpoint: { select: { name: true } },
              items: {
                include: { item: { select: { itemName: true } }, uom: { select: { symbol: true } } },
              },
            },
            orderBy: { importDatetime: "desc" },
            take: 200,
          });
    const entriesTotal =
      scopeCheck.kind === "none"
        ? 0
        : await db.importEntry.count({
            where: {
              importerId,
              importDatetime: { gte: from, lte: to },
              ...(portFilter as object),
            },
          });

    // Flatten items to the declared summary contract.
    const flatEntries = entries.map((e) => ({
      id: e.id,
      entryNumber: e.entryNumber,
      importDatetime: e.importDatetime,
      status: e.status,
      checkpoint: { name: e.checkpoint.name },
      items: e.items.map((it) => ({
        itemName: it.item.itemName,
        quantity: it.quantity,
        uomSymbol: it.uom.symbol,
      })),
    }));

    return ok({
      importer: {
        ...rest,
        hasPhoto: Boolean(importer.photoData),
      },
      quotas,
      today: {
        approvedEntries: todayEntriesCount,
        approvedBaseQuantity: todayApprovedBase,
        lastImportAt: lastEntry?.importDatetime ?? null,
        lastCheckpointName: lastEntry?.checkpoint.name ?? null,
      },
      entries: flatEntries,
      entriesTotal,
      window: { from: from.toISOString(), to: to.toISOString() },
    });
  } catch (e) {
    return handleApiError(e);
  }
}
