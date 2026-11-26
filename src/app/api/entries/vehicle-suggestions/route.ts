import { db } from "@/lib/db";
import { handleApiError, ok, requireUser } from "@/lib/api";
import { scopedCheckpointFilter, requirePortScope } from "@/lib/scope";

/**
 * GET /api/entries/vehicle-suggestions?importerId=&checkpointId=
 *
 * Distinct vehicle plates previously used by this importer at this port
 * (server-enforced scope). Offered as SUGGESTIONS in the entry form only —
 * a plate is never silently auto-applied to a new transaction.
 */
export async function GET(request: Request) {
  try {
    const auth = await requireUser();
    if (auth.response) return auth.response;
    const scopeCheck = requirePortScope(auth.user);
    if (!scopeCheck.ok) return ok({ plates: [] });
    const { searchParams } = new URL(request.url);
    const importerId = Number(searchParams.get("importerId"));
    if (!importerId) return ok({ plates: [] });
    const cpFilter = scopedCheckpointFilter(
      auth.user,
      searchParams.get("checkpointId") ? Number(searchParams.get("checkpointId")) : null
    );
    const rows = await db.importEntry.findMany({
      where: {
        AND: [cpFilter, { importerId }, { vehicleNumber: { not: null } }, { vehicleNumber: { not: "" } }],
      },
      select: { vehicleNumber: true },
      distinct: ["vehicleNumber"],
      orderBy: { importDatetime: "desc" },
      take: 12,
    });
    return ok({ plates: rows.map((r) => r.vehicleNumber).filter((v): v is string => Boolean(v)) });
  } catch (e) {
    return handleApiError(e);
  }
}
