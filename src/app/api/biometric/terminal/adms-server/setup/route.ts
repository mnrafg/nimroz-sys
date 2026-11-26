import { fail, handleApiError, ok, requireUser, readJson, FriendlyApiError } from "@/lib/api";
import { setupBodySchema } from "@/lib/biometric/adms-setup-contract";
import { createNdjsonResponse } from "@/lib/biometric/adms-setup-response";
import {
  activateAction,
  fingerprintAction,
  inspectAction,
  planAction,
  runInstall,
} from "@/lib/biometric/adms-setup";

// ============================================================
// POST /api/biometric/terminal/adms-server/setup  (ADMIN only)
//
// One action per call:
//   fingerprint → 200 JSON { fingerprint, keyType }   (NO password sent)
//   inspect     → 200 JSON { facts, listeners, deviceObservations, findings, planProposal }
//   plan        → 200 JSON { planToken, plan, summary } (signed, ~10 min, single-use)
//   install     → NDJSON STREAM (stage/progress/log/need-inspect/done/error)
//   activate    → 200 JSON { activated, settings } (after live authenticated TLS check)
//
// SECURITY: the SSH password is transient — it is parsed here, passed
// to the SSH layer in memory and dropped. It is never logged, never
// persisted, never included in audit entries, URLs, query caches or
// error messages (zod failure messages never echo the value). TLS of
// the ADMS API is verified with the pinned CA; rejectUnauthorized is
// never disabled anywhere.
// ============================================================

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await requireUser(["ADMIN"]);
  if (auth.response) return auth.response;
  const adminId = auth.user.id;

  const body = await readJson(request, setupBodySchema);
  if (body.response) return body.response;
  const data = body.data;

  try {
    switch (data.action) {
      case "fingerprint":
        return ok(await fingerprintAction(data));
      case "inspect":
        return ok(await inspectAction(data));
      case "plan":
        return ok(await planAction(data, adminId));
      case "activate":
        return ok(await activateAction(data, adminId));
      case "install":
        // NDJSON streaming response; progress is flushed per event and
        // the stream flags itself closed when the client disconnects.
        return createNdjsonResponse({
          signal: request.signal,
          run: (emit) => runInstall(emit, data, adminId),
        });
    }
    return fail("عملیات درخواستی شناخته نشد.");
  } catch (e) {
    if (e instanceof FriendlyApiError) return fail(e.message, 400);
    return handleApiError(e);
  }
}
