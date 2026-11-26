import { db } from "@/lib/db";
import { logAudit } from "@/lib/auth";
import { handleApiError, ok, requireUser } from "@/lib/api";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireUser(["ADMIN"]);
    if (auth.response) return auth.response;
    const { id } = await params;
    const existing = await db.uomConversion.findUnique({ where: { id: Number(id) } });
    if (!existing) return ok({ error: "تبدیل مورد نظر پیدا نشد." }, 404);
    await db.uomConversion.delete({ where: { id: Number(id) } });
    await logAudit(auth.user.id, "DELETE", "UOM_CONVERSION", Number(id), existing, null);
    return ok({ success: true });
  } catch (e) {
    return handleApiError(e);
  }
}
