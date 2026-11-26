import { z } from "zod";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/auth";
import { requireUser, ok, readJson, handleApiError } from "@/lib/api";
import { canManageImporter, importerScopeEvidence, NO_PORT_MESSAGE } from "@/lib/scope";

const schema = z.object({
  importerId: z.number().int().positive(),
});

/** Audit the printing of an importer identification card (metadata only). */
export async function POST(request: Request) {
  try {
    const auth = await requireUser(["ADMIN", "OFFICER"]);
    if (auth.response) return auth.response;
    const parsed = await readJson(request, schema);
    if (parsed.response) return parsed.response;

    const importer = await db.importer.findUnique({
      where: { id: parsed.data.importerId },
      select: { id: true, importerCode: true, idCardNumber: true, registeredCheckpointId: true, ...importerScopeEvidence },
    });
    if (!importer) return ok({ error: "واردکننده مورد نظر پیدا نشد." }, 404);
    // V3 fix — port isolation on card printing audit.
    if (auth.user.role !== "ADMIN" && !auth.user.checkpointId) {
      return ok({ error: NO_PORT_MESSAGE }, 403);
    }
    if (!canManageImporter(auth.user, importer)) {
      return ok({ error: "شما فقط به واردکنندگان بندر مسئولیت خود دسترسی دارید." }, 403);
    }

    await logAudit(auth.user.id, "CARD_PRINT", "IMPORTER", importer.id, null, {
      importerId: importer.id,
      importerCode: importer.importerCode,
      cardNumber: importer.idCardNumber ?? null,
    });
    return ok({ logged: true });
  } catch (e) {
    return handleApiError(e);
  }
}
