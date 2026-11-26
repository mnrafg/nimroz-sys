import { db } from "@/lib/db";
import { handleApiError, ok, requireUser } from "@/lib/api";
import { requirePortScope, scopedCheckpointFilter } from "@/lib/scope";
import { startOfTodayKabul } from "@/lib/jalali";
import { computeQuotaUsages } from "@/lib/quota";
import { getAutomationSettings } from "@/lib/settings";

/**
 * GET /api/notifications
 *
 * Lightweight counters for the top-bar notification bell. All counts are
 * computed within the authenticated user's SERVER-enforced port scope —
 * the client can never widen them. Designed to be polled every ~60s.
 *
 * (No approval workflow exists anymore: the bell reports quota alerts,
 * today's finalized imports and open drafts.)
 */
export async function GET() {
  try {
    const auth = await requireUser();
    if (auth.response) return auth.response;
    const scopeCheck = requirePortScope(auth.user);
    if (!scopeCheck.ok) {
      // Port-less non-admins have no operational data at all.
      return ok({ quotaAlerts: 0, todayImports: 0, draftEntries: 0 });
    }
    const cpFilter = scopedCheckpointFilter(auth.user, null);

    const todayStart = startOfTodayKabul();
    const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

    const [todayImports, draftEntries, activeLimits] = await Promise.all([
      db.importEntry.count({
        where: { ...cpFilter, status: "APPROVED", importDatetime: { gte: todayStart, lt: todayEnd } },
      }),
      db.importEntry.count({ where: { ...cpFilter, status: "DRAFT" } }),
      db.importLimit.findMany({
        where: { ...cpFilter, isActive: true, effectiveFrom: { lte: new Date() } },
        select: {
          id: true,
          ownerType: true,
          importerId: true,
          groupId: true,
          checkpointId: true,
          allowedQuantity: true,
          uomId: true,
          periodType: true,
          effectiveFrom: true,
          effectiveTo: true,
          restrictItemId: true,
          restrictCategoryId: true,
        },
        take: 200,
      }),
    ]);

    // Quota alerts reuse the same threshold as the dashboard (configurable
    // via SystemSetting) — computed in ONE batched pass.
    const usageMap = await computeQuotaUsages(activeLimits, new Date());
    const automation = await getAutomationSettings();
    const nearThreshold = automation.quotaAlertThresholdPercent;
    let quotaAlerts = 0;
    for (const lim of activeLimits) {
      const q = usageMap.get(lim.id);
      if (!q) continue;
      if (q.allowedQuantity > 0 && (q.usagePercent ?? 0) >= nearThreshold) quotaAlerts += 1;
    }

    return ok({ quotaAlerts, todayImports, draftEntries });
  } catch (e) {
    return handleApiError(e);
  }
}
