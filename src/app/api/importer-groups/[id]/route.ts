import { z } from "zod";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/auth";
import { handleApiError, ok, readJson, requireUser } from "@/lib/api";
import { validateGroupRepresentative } from "@/lib/importer-groups";
import { portScopeFor } from "@/lib/scope";
import { formatJalali } from "@/lib/jalali";
import { computeQuotaUsages } from "@/lib/quota";

/**
 * GET /api/importer-groups/[id]?from&to
 *
 * Group record + subgroups + members + a simple import summary computed
 * from the EXISTING ImportEntry / ImportEntryItem records — no duplicated
 * transaction storage, no separate group-import database. Operational
 * figures are PORT-SCOPED for non-admins. Petrol/diesel totals only ever
 * sum liter-denominated base quantities (never mixed with incompatible
 * units). Group membership does NOT create or increase individual quotas.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireUser();
    if (auth.response) return auth.response;
    const { id } = await params;
    const groupId = Number(id);
    if (!Number.isFinite(groupId)) return ok({ error: "شناسه گروپ نامعتبر است." }, 400);

    const group = await db.importerGroup.findUnique({
      where: { id: groupId },
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        mandateDoc: true,
        undertakingDoc: true,
        status: true,
        createdAt: true,
        representative: { select: { id: true, name: true, importerCode: true } },
      },
    });
    if (!group) return ok({ error: "گروپ مورد نظر پیدا نشد." }, 404);

    const subgroups = await db.importerSubgroup.findMany({
      where: { groupId },
      select: {
        id: true,
        code: true,
        name: true,
        status: true,
        _count: { select: { members: true } },
      },
      orderBy: { code: "asc" },
    });

    const members = await db.importer.findMany({
      where: { groupId },
      select: {
        id: true,
        importerCode: true,
        name: true,
        fatherName: true,
        importerType: true,
        membershipStatus: true,
        biometricStatus: true,
        photoData: true,
        subgroupId: true,
      },
      orderBy: { importerCode: "asc" },
    });
    const membersClean = members.map((m) => ({
      id: m.id,
      importerCode: m.importerCode,
      name: m.name,
      fatherName: m.fatherName,
      importerType: m.importerType,
      membershipStatus: m.membershipStatus,
      biometricStatus: m.biometricStatus,
      hasPhoto: Boolean(m.photoData),
      subgroupId: m.subgroupId,
    }));

    // ---- Import summary — from existing records only, port-scoped ----
    const scope = portScopeFor(auth.user);
    const portFilter = scope.kind === "port" ? { checkpointId: scope.checkpointId } : {};

    const { searchParams } = new URL(request.url);
    const to = searchParams.get("to") ? new Date(searchParams.get("to")!) : new Date();
    const from = searchParams.get("from")
      ? new Date(searchParams.get("from")!)
      : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);

    const memberIds = membersClean.map((m) => m.id);

    const entries =
      scope.kind === "none" || memberIds.length === 0
        ? []
        : await db.importEntry.findMany({
            where: {
              importerId: { in: memberIds },
              status: "APPROVED",
              importDatetime: { gte: from, lte: to },
              ...(portFilter as object),
            },
            select: {
              id: true,
              importerId: true,
              importDatetime: true,
              items: { select: { itemId: true, baseQuantity: true } },
            },
            orderBy: { importDatetime: "desc" },
            take: 1000,
          });

    // Fuel items (petrol / diesel) — matched by name; both liter-based,
    // so their base quantities may be summed safely.
    const fuelItems = await db.item.findMany({ select: { id: true, itemName: true } });
    const petrolIds = new Set(fuelItems.filter((i) => i.itemName.includes("پطرول")).map((i) => i.id));
    const dieselIds = new Set(fuelItems.filter((i) => i.itemName.includes("دیزل")).map((i) => i.id));

    let petrolLiters = 0;
    let dieselLiters = 0;
    const byMemberMap = new Map<number, { importerId: number; name: string; importerCode: string; entries: number; petrolLiters: number; dieselLiters: number }>();
    const byDateMap = new Map<string, { date: string; entries: number; petrolLiters: number; dieselLiters: number }>();
    const memberById = new Map(membersClean.map((m) => [m.id, m]));

    for (const e of entries) {
      let entryPetrol = 0;
      let entryDiesel = 0;
      for (const it of e.items) {
        if (petrolIds.has(it.itemId)) entryPetrol += it.baseQuantity ?? 0;
        else if (dieselIds.has(it.itemId)) entryDiesel += it.baseQuantity ?? 0;
      }
      petrolLiters += entryPetrol;
      dieselLiters += entryDiesel;

      const m = memberById.get(e.importerId);
      if (m) {
        const row = byMemberMap.get(e.importerId) ?? {
          importerId: e.importerId,
          name: m.name,
          importerCode: m.importerCode,
          entries: 0,
          petrolLiters: 0,
          dieselLiters: 0,
        };
        row.entries += 1;
        row.petrolLiters += entryPetrol;
        row.dieselLiters += entryDiesel;
        byMemberMap.set(e.importerId, row);
      }

      const dateKey = formatJalali(e.importDatetime);
      const dRow = byDateMap.get(dateKey) ?? { date: dateKey, entries: 0, petrolLiters: 0, dieselLiters: 0 };
      dRow.entries += 1;
      dRow.petrolLiters += entryPetrol;
      dRow.dieselLiters += entryDiesel;
      byDateMap.set(dateKey, dRow);
    }

    const summary = {
      activeMembers: membersClean.filter((m) => m.membershipStatus === "ACTIVE").length,
      totalEntries: entries.length,
      petrolLiters: Math.round(petrolLiters * 1000) / 1000,
      dieselLiters: Math.round(dieselLiters * 1000) / 1000,
      byMember: Array.from(byMemberMap.values()).sort((a, b) => b.entries - a.entries),
      byDate: Array.from(byDateMap.values()).sort((a, b) => (a.date < b.date ? 1 : -1)),
      window: { from: from.toISOString(), to: to.toISOString() },
    };

    // ---- GROUP quotas — PER-MEMBER allowances. allowedQuantity is each
    // member's PERSONAL cap; the group pool multiplies by the ACTIVE
    // member count. The breakdown by member shows each member's own
    // consumption against their personal allowance. ----
    const sharedQuotas = await db.importLimit.findMany({
      where: {
        ownerType: "GROUP",
        groupId,
        isActive: true,
        // Scheduled (future) quotas are included too so admins see the
        // upcoming shared balance; validity is reported per quota.
        ...(portFilter as object),
      },
      include: {
        checkpoint: { select: { id: true, name: true } },
        uom: { select: { name: true, symbol: true } },
        restrictItem: { select: { itemName: true } },
      },
    });
    const quotaUsages = await computeQuotaUsages(sharedQuotas, new Date());
    const memberCharges = await db.importEntry.groupBy({
      by: ["importerId", "appliedLimitId"],
      where: {
        appliedLimitId: { in: sharedQuotas.map((q) => q.id) },
        status: "APPROVED",
        importDatetime: { gte: from, lte: to },
        ...(portFilter as object),
      },
      _sum: { quotaChargedQuantity: true },
      _count: { id: true },
    });
    const sharedQuotaSummary = sharedQuotas.map((q) => {
      const usage = quotaUsages.get(q.id);
      const charges = memberCharges
        .filter((c) => c.appliedLimitId === q.id)
        .map((c) => {
          const m = memberById.get(c.importerId);
          const charged = Math.round((c._sum.quotaChargedQuantity ?? 0) * 1000) / 1000;
          return {
            importerId: c.importerId,
            name: m?.name ?? "—",
            importerCode: m?.importerCode ?? "",
            entries: c._count.id,
            chargedQuantity: charged,
            // Personal allowance left for THIS member (per-member cap).
            memberRemaining: Math.round((q.allowedQuantity - charged) * 1000) / 1000,
          };
        })
        .sort((a, b) => b.chargedQuantity - a.chargedQuantity);
      return {
        limitId: q.id,
        checkpoint: q.checkpoint,
        periodType: q.periodType,
        // PER-MEMBER allowance — every active member owns this amount.
        allowedQuantity: q.allowedQuantity,
        uomSymbol: q.uom.symbol,
        restriction: q.restrictItem?.itemName ?? null,
        windowLabel: usage?.windowLabel ?? null,
        memberCount: usage?.memberCount ?? null,
        totalAllowed: usage?.totalAllowedQuantity ?? null,
        consumed: usage?.consumed ?? 0,
        remaining: usage?.available ?? 0,
        excess: usage?.excess ?? 0,
        usagePercent: usage?.usagePercent ?? null,
        byMember: charges,
      };
    });

    return ok({ group, subgroups, members: membersClean, summary, sharedQuotas: sharedQuotaSummary });
  } catch (e) {
    return handleApiError(e);
  }
}

const groupUpdateSchema = z.object({
  // SYSTEM-OWNED identity — the group code is allocated by the server and
  // immutable. Change attempts are rejected outright.
  code: z.string().optional(),
  name: z.string().min(2).optional(),
  representativeId: z.number().int().nullable().optional(),
  description: z.string().nullable().optional(),
  mandateDoc: z.string().nullable().optional(),
  undertakingDoc: z.string().nullable().optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireUser(["ADMIN"]);
    if (auth.response) return auth.response;
    const { id } = await params;
    const groupId = Number(id);
    const existing = await db.importerGroup.findUnique({ where: { id: groupId } });
    if (!existing) return ok({ error: "گروپ مورد نظر پیدا نشد." }, 404);

    const parsed = await readJson(request, groupUpdateSchema);
    if (parsed.response) return parsed.response;
    const data = parsed.data;

    // SYSTEM-OWNED IDENTIFIER — group codes are server-allocated and never
    // change, even via API requests.
    if (data.code !== undefined && data.code?.trim().toUpperCase() !== existing.code.toUpperCase()) {
      return ok({ error: "کود گروپ توسط سیستم تولید می‌شود و قابل تغییر نیست." }, 400);
    }
    delete data.code;

    const repError = await validateGroupRepresentative(
      data.representativeId === undefined ? existing.representativeId : data.representativeId
    );
    if (repError) return ok({ error: repError }, 400);

    const group = await db.importerGroup.update({
      where: { id: groupId },
      data: {
        name: data.name?.trim(),
        representativeId: data.representativeId === undefined ? undefined : data.representativeId,
        description: data.description === undefined ? undefined : data.description?.trim() || null,
        mandateDoc: data.mandateDoc === undefined ? undefined : data.mandateDoc?.trim() || null,
        undertakingDoc: data.undertakingDoc === undefined ? undefined : data.undertakingDoc?.trim() || null,
        status: data.status,
      },
      include: { representative: { select: { id: true, name: true, importerCode: true } } },
    });
    await logAudit(
      auth.user.id,
      existing.status !== group.status ? "STATUS_CHANGE" : "UPDATE",
      "IMPORTER_GROUP",
      group.id,
      existing,
      group
    );
    return ok({ group });
  } catch (e) {
    return handleApiError(e);
  }
}
