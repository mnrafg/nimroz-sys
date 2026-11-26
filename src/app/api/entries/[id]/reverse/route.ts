import { z } from "zod";
import { db } from "@/lib/db";
import { fail, handleApiError, ok, readJson, requireUser } from "@/lib/api";
import { assertPortAccess } from "@/lib/scope";

/**
 * Authorized, audited reversal of an APPROVED entry.
 * Reversal frees the consumed quota (only APPROVED entries count).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireUser(["ADMIN"]);
    if (auth.response) return auth.response;
    const { id } = await params;
    const parsed = await readJson(
      request,
      z.object({
        remarks: z.string({ message: "لطفاً دلیل ابطال را بنویسید." }).min(3, "لطفاً دلیل ابطال را بنویسید."),
      })
    );
    if (parsed.response) return parsed.response;

    const entryId = Number(id);
    const existing = await db.importEntry.findUnique({ where: { id: entryId } });
    if (!existing) return fail("ثبت واردات مورد نظر پیدا نشد.", 404);
    // Port isolation: reversal is restricted to the entry's own port.
    const portError = assertPortAccess(auth.user, existing.checkpointId);
    if (portError) return fail(portError, 403);
    // IDEMPOTENT CANCELLATION: repeating an already-successful reversal
    // returns the same record instead of failing — consumption is reversed
    // exactly once (status flips APPROVED → REVERSED only here).
    if (existing.status === "REVERSED") {
      const already = await db.importEntry.findUnique({
        where: { id: entryId },
        include: {
          importer: { select: { name: true, companyName: true } },
          checkpoint: { select: { name: true } },
          items: true,
        },
      });
      return ok({ entry: already, idempotentReplay: true });
    }
    if (existing.status !== "APPROVED") {
      return fail("فقط ثبت‌های تأییدشده قابل ابطال هستند.", 400);
    }

    const entry = await db.$transaction(async (tx) => {
      const updated = await tx.importEntry.update({
        where: { id: entryId },
        data: { status: "REVERSED" },
        include: {
          importer: { select: { name: true, companyName: true } },
          checkpoint: { select: { name: true } },
          items: true,
        },
      });
      await tx.approvalAction.create({
        data: {
          importEntryId: entryId,
          actionType: "REVERSE",
          actionBy: auth.user.id,
          remarks: parsed.data.remarks.trim(),
        },
      });
      await tx.auditLog.create({
        data: {
          userId: auth.user.id,
          action: "REVERSE",
          recordType: "IMPORT_ENTRY",
          recordId: entryId,
          oldValues: JSON.stringify({ status: "APPROVED" }),
          newValues: JSON.stringify({ status: "REVERSED", reason: parsed.data.remarks }),
        },
      });
      return updated;
    });

    return ok({ entry });
  } catch (e) {
    return handleApiError(e);
  }
}
