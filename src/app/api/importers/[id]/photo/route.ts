import { db } from "@/lib/db";
import { fail, handleApiError, ok, requireUser } from "@/lib/api";
import { canViewImporter, importerScopeEvidence, NO_PORT_MESSAGE, portScopeFor } from "@/lib/scope";

/**
 * GET /api/importers/[id]/photo
 * Authenticated importer photograph (base64 JPEG stored on the Importer row).
 * Returns 404 when no photo exists. Biometric templates are NEVER exposed here.
 *
 * V5 fix — photo downloads are registry-scoped like every other importer
 * endpoint: a port-less non-admin gets nothing, and a port user cannot
 * fetch photos of importers outside their registry scope by guessing IDs.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireUser();
    if (auth.response) return auth.response;
    if (portScopeFor(auth.user).kind === "none") {
      return fail(NO_PORT_MESSAGE, 403);
    }
    const { id } = await params;
    const importer = await db.importer.findUnique({
      where: { id: Number(id) },
      select: { photoData: true, registeredCheckpointId: true, ...importerScopeEvidence },
    });
    if (!importer?.photoData) {
      return fail("عکسی ثبت نشده است.", 404);
    }
    if (!canViewImporter(auth.user, importer)) {
      return fail("شما فقط به واردکنندگان بندر مسئولیت خود دسترسی دارید.", 403);
    }
    const bytes = Buffer.from(importer.photoData, "base64");
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch (e) {
    return handleApiError(e);
  }
}
