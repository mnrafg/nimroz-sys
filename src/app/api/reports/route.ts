import { db } from "@/lib/db";
import { fail, handleApiError, ok, requireUser } from "@/lib/api";
import { buildReport } from "@/lib/reports";
import { importerVisibilityWhere, requirePortScope } from "@/lib/scope";

export async function GET(request: Request) {
  try {
    const auth = await requireUser();
    if (auth.response) return auth.response;
    // Reports are operational data — server-enforced port scope. The
    // requested port filter is honored only for admins.
    const scopeCheck = requirePortScope(auth.user);
    if (!scopeCheck.ok) return fail(scopeCheck.message, 403);
    // V14 fix — meta lookups (importer names) honor registry visibility.
    const visibility = importerVisibilityWhere(auth.user);
    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type") || "daily";
    const from = searchParams.get("from") ? new Date(searchParams.get("from")!) : null;
    const to = searchParams.get("to") ? new Date(searchParams.get("to")!) : null;
    const requestedCheckpointId = searchParams.get("checkpointId") ? Number(searchParams.get("checkpointId")) : null;
    const importerId = searchParams.get("importerId") ? Number(searchParams.get("importerId")) : null;
    const groupId = searchParams.get("groupId") ? Number(searchParams.get("groupId")) : null;
    const itemId = searchParams.get("itemId") ? Number(searchParams.get("itemId")) : null;
    const q = searchParams.get("q");
    const asOfParam = searchParams.get("asOf");
    const asOf = asOfParam && !Number.isNaN(new Date(asOfParam).getTime()) ? new Date(asOfParam) : null;
    const includeReversed = searchParams.get("includeReversed") === "1";

    const checkpointId =
      scopeCheck.scope.kind === "port" ? scopeCheck.scope.checkpointId : requestedCheckpointId;

    const report = await buildReport(
      type,
      {
        from,
        to,
        checkpointId,
        importerId,
        groupId,
        itemId,
        q: q ? q.trim() || null : null,
        asOf,
        includeReversed,
        importerVisibility: visibility,
      },
      auth.user.name
    );
    return ok({ report });
  } catch (e) {
    if (e instanceof Error && e.message.includes("نوع گزارش")) {
      return fail(e.message);
    }
    return handleApiError(e);
  }
}
