import { db } from "@/lib/db";
import { fail, handleApiError, ok, requireUser } from "@/lib/api";
import { resolveQuotaForEntry } from "@/lib/quota";
import { requirePortScope } from "@/lib/scope";

/**
 * GET /api/limits/resolve?importerId=&checkpointId=&date=ISO&rows=itemId:qty:uomId,…
 *
 * Resolves the ONE quota that a transaction would consume (individual
 * precedence over group) and returns the compact registration preview:
 * owner/source, authorized, consumed, current total across ALL rows,
 * projected remaining/excess. Conversion uses configured factors only.
 */
export async function GET(request: Request) {
  try {
    const auth = await requireUser();
    if (auth.response) return auth.response;
    const scopeCheck = requirePortScope(auth.user);
    if (!scopeCheck.ok) return fail(scopeCheck.message, 403);
    const { searchParams } = new URL(request.url);
    const importerId = Number(searchParams.get("importerId"));
    const checkpointId = Number(searchParams.get("checkpointId"));
    const dateParam = searchParams.get("date");
    const date = dateParam && !Number.isNaN(new Date(dateParam).getTime()) ? new Date(dateParam) : new Date();
    const rowsParam = searchParams.get("rows") ?? "";

    if (!importerId || !checkpointId) {
      return fail("پارامترهای لازم ارسال نشده است.");
    }
    if (
      scopeCheck.scope.kind === "port" &&
      scopeCheck.scope.checkpointId !== checkpointId
    ) {
      return fail("شما فقط سهمیه‌های بندر مسئولیت خود را می‌توانید بررسی کنید.", 403);
    }

    const rows: { itemId: number; itemName?: string; quantity: number; uomId: number }[] = [];
    for (const part of rowsParam.split(",").filter(Boolean)) {
      const [itemId, qty, uomId] = part.split(":").map(Number);
      if (itemId && uomId && Number.isFinite(qty) && qty > 0) {
        rows.push({ itemId, quantity: qty, uomId });
      }
    }
    // Item names for precise Dari messages when a row can't be covered.
    if (rows.length) {
      const items = await db.item.findMany({
        where: { id: { in: rows.map((r) => r.itemId) } },
        select: { id: true, itemName: true },
      });
      const nameById = new Map(items.map((i) => [i.id, i.itemName]));
      for (const r of rows) r.itemName = nameById.get(r.itemId);
    }

    const resolution = await resolveQuotaForEntry({ importerId, checkpointId, date, rows });
    return ok({ resolution });
  } catch (e) {
    return handleApiError(e);
  }
}
