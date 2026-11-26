import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser, ok, fail, readJson, handleApiError } from "@/lib/api";
import { cardToken } from "@/lib/biometric/matcher";
import { canManageImporter, importerScopeEvidence, NO_PORT_MESSAGE } from "@/lib/scope";

const schema = z.object({
  importerId: z.number().int().positive(),
});

/**
 * POST /api/biometric/card-token
 * Issues the OPAQUE, signed, revocable QR verifier token for an importer's
 * identification card. Requires an authorized session. If the importer has
 * no card number yet, a persistent one is generated and saved.
 */
export async function POST(request: Request) {
  try {
    const auth = await requireUser(["ADMIN", "OFFICER"]);
    if (auth.response) return auth.response;
    const parsed = await readJson(request, schema);
    if (parsed.response) return parsed.response;

    const importer = await db.importer.findUnique({
      where: { id: parsed.data.importerId },
      select: { id: true, importerCode: true, idCardNumber: true, status: true, registeredCheckpointId: true, ...importerScopeEvidence },
    });
    if (!importer) return fail("واردکننده مورد نظر پیدا نشد.", 404);
    // V3 fix — port isolation: card tokens can only be minted by an
    // ADMIN or an OFFICER authorized to manage this importer.
    if (auth.user.role !== "ADMIN" && !auth.user.checkpointId) {
      return fail(NO_PORT_MESSAGE, 403);
    }
    if (!canManageImporter(auth.user, importer)) {
      return fail("شما فقط به واردکنندگان بندر مسئولیت خود دسترسی دارید.", 403);
    }
    if (importer.status !== "ACTIVE") {
      return fail("برای واردکننده غیرفعال نمی‌توان کارت شناسایی صادر کرد.", 400);
    }

    let cardNumber = importer.idCardNumber;
    if (!cardNumber) {
      // Persistent card number (printed on the card) — generated once.
      const base = `AOGC-IC-${String(importer.id).padStart(4, "0")}`;
      let saved = false;
      for (let attempt = 0; attempt < 5 && !saved; attempt++) {
        cardNumber = attempt === 0 ? base : `${base}-${attempt}`;
        try {
          await db.importer.update({
            where: { id: importer.id },
            data: { idCardNumber: cardNumber },
          });
          saved = true;
        } catch {
          saved = false;
        }
      }
      if (!saved) return fail("صدور شماره کارت ناموفق بود؛ لطفاً دوباره تلاش کنید.", 500);
    }
    if (!cardNumber) {
      return fail("شماره کارت در دسترس نیست؛ لطفاً دوباره تلاش کنید.", 500);
    }

    return ok({
      cardNumber,
      token: cardToken(cardNumber),
      verifyPath: "/api/biometric/card-verify",
    });
  } catch (e) {
    return handleApiError(e);
  }
}
