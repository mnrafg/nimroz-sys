import { db } from "@/lib/db";
import { handleApiError, ok, requireUser, round3 } from "@/lib/api";
import { convertQuantity } from "@/lib/quota";
import { getAutomationSettings } from "@/lib/settings";
import { scopedCheckpointFilter, requirePortScope } from "@/lib/scope";

/**
 * GET /api/entries/duplicate-check?importerId=&checkpointId=&items=itemId:qty:uomId,…
 *
 * Warns about LIKELY duplicate registrations: APPROVED entries of the same
 * importer/port containing the same item within a configurable window
 * (SystemSetting alerts.duplicateWindowMinutes, default 30).
 *
 * A warning is informational only — a legitimate repeated shipment may be
 * confirmed by the officer; nothing is auto-deleted or blocked.
 */
export async function GET(request: Request) {
  try {
    const auth = await requireUser();
    if (auth.response) return auth.response;
    const scopeCheck = requirePortScope(auth.user);
    if (!scopeCheck.ok) return ok({ duplicates: [] });
    const { searchParams } = new URL(request.url);
    const importerId = Number(searchParams.get("importerId"));
    const checkpointId = Number(searchParams.get("checkpointId"));
    if (!importerId || !checkpointId) return ok({ duplicates: [] });

    // Parse requested items: "itemId:quantity:uomId" triples — quantities
    // are normalized server-side into each item's base UOM.
    const itemsParam = searchParams.get("items") ?? "";
    const wanted: { itemId: number; baseQty: number }[] = [];
    const parsedParts = itemsParam
      .split(",")
      .filter(Boolean)
      .map((part) => {
        const [idStr, qtyStr, uomStr] = part.split(":");
        return { itemId: Number(idStr), qty: Number(qtyStr), uomId: Number(uomStr) };
      })
      .filter((p) => p.itemId && p.uomId && Number.isFinite(p.qty) && p.qty > 0);
    if (parsedParts.length > 0) {
      const itemRows = await db.item.findMany({
        where: { id: { in: parsedParts.map((p) => p.itemId) } },
        select: { id: true, baseUomId: true },
      });
      const baseUomByItem = new Map(itemRows.map((i) => [i.id, i.baseUomId]));
      for (const p of parsedParts) {
        const baseUomId = baseUomByItem.get(p.itemId);
        if (!baseUomId) continue;
        const base = await convertQuantity(p.qty, p.uomId, baseUomId, p.itemId);
        if (base !== null) wanted.push({ itemId: p.itemId, baseQty: base });
      }
    }

    const settings = await getAutomationSettings();
    const windowMinutes = settings.duplicateWindowMinutes;
    if (windowMinutes <= 0 || wanted.length === 0) return ok({ duplicates: [] });

    const windowStart = new Date(Date.now() - windowMinutes * 60_000);
    const cpFilter = scopedCheckpointFilter(auth.user, checkpointId);

    const entries = await db.importEntry.findMany({
      where: {
        AND: [cpFilter, { importerId }, { status: "APPROVED" }, { importDatetime: { gte: windowStart } }],
      },
      include: {
        items: {
          select: {
            itemId: true,
            baseQuantity: true,
            quantity: true,
            uom: { select: { symbol: true } },
            item: { select: { itemName: true } },
          },
        },
      },
      orderBy: { importDatetime: "desc" },
      take: 10,
    });

    const duplicates: {
      id: number;
      entryNumber: string;
      importDatetime: Date;
      matchedItems: {
        itemId: number;
        itemName: string;
        quantity: number;
        uom: string;
        baseQuantity: number;
        similarMagnitude: boolean;
      }[];
    }[] = [];
    for (const entry of entries) {
      const matchedItems: {
        itemId: number;
        itemName: string;
        quantity: number;
        uom: string;
        baseQuantity: number;
        similarMagnitude: boolean;
      }[] = [];
      for (const row of entry.items) {
        const w = wanted.find((x) => x.itemId === row.itemId);
        if (!w) continue;
        // Same item within the window. Similar magnitude (±25%) strengthens
        // the signal but ANY overlap is reported.
        const similar = Math.abs(w.baseQty - row.baseQuantity) <= Math.max(w.baseQty, row.baseQuantity) * 0.25;
        matchedItems.push({
          itemId: row.itemId,
          itemName: row.item.itemName,
          quantity: round3(row.quantity),
          uom: row.uom.symbol,
          baseQuantity: round3(row.baseQuantity),
          similarMagnitude: similar,
        });
      }
      if (matchedItems.length > 0) {
        duplicates.push({
          id: entry.id,
          entryNumber: entry.entryNumber,
          importDatetime: entry.importDatetime,
          matchedItems,
        });
      }
    }

    return ok({ duplicates, windowMinutes });
  } catch (e) {
    return handleApiError(e);
  }
}
