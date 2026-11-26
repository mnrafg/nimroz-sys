import { db } from "@/lib/db";
import { handleApiError, ok, requireUser } from "@/lib/api";

/**
 * GET /api/audit-logs?recordType=&action=&q=&page=&pageSize=
 *
 * Filtered, paginated audit history (ADMIN only). Passwords and biometric
 * templates are never written to logs, so nothing sensitive can leak.
 */
export async function GET(request: Request) {
  try {
    const auth = await requireUser(["ADMIN"]);
    if (auth.response) return auth.response;
    const { searchParams } = new URL(request.url);
    const recordType = searchParams.get("recordType")?.trim();
    const action = searchParams.get("action")?.trim();
    const q = searchParams.get("q")?.trim();
    const page = Math.max(1, Number(searchParams.get("page") ?? 1) || 1);
    const pageSize = Math.min(100, Math.max(10, Number(searchParams.get("pageSize") ?? 30) || 30));

    const logs = await db.auditLog.findMany({
      where: {
        AND: [
          recordType ? { recordType } : {},
          action ? { action } : {},
          q ? { OR: [{ action: { contains: q } }, { recordType: { contains: q } }] } : {},
        ],
      },
      include: { user: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    const total = await db.auditLog.count({
      where: {
        AND: [
          recordType ? { recordType } : {},
          action ? { action } : {},
          q ? { OR: [{ action: { contains: q } }, { recordType: { contains: q } }] } : {},
        ],
      },
    });

    const recordTypes = await db.auditLog.findMany({
      select: { recordType: true },
      distinct: ["recordType"],
    });
    const actions = await db.auditLog.findMany({
      select: { action: true },
      distinct: ["action"],
    });

    return ok({
      logs,
      total,
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
      facets: {
        recordTypes: recordTypes.map((r) => r.recordType).sort(),
        actions: actions.map((a) => a.action).sort(),
      },
    });
  } catch (e) {
    return handleApiError(e);
  }
}
