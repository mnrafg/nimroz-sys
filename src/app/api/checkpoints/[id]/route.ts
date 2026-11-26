import { z } from "zod";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/auth";
import { handleApiError, ok, readJson, requireUser } from "@/lib/api";

const cpUpdateSchema = z.object({
  code: z.string().min(1).optional(),
  name: z.string().min(2).optional(),
  province: z.string().min(2).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireUser(["ADMIN"]);
    if (auth.response) return auth.response;
    const { id } = await params;
    const parsed = await readJson(request, cpUpdateSchema);
    if (parsed.response) return parsed.response;

    const existing = await db.borderCheckpoint.findUnique({ where: { id: Number(id) } });
    if (!existing) return ok({ error: "بندر مورد نظر پیدا نشد." }, 404);

    const data = parsed.data;
    const checkpoint = await db.borderCheckpoint.update({
      where: { id: Number(id) },
      data: {
        ...data,
        code: data.code?.trim().toUpperCase(),
        name: data.name?.trim(),
        province: data.province?.trim(),
      },
    });
    await logAudit(auth.user.id, "UPDATE", "CHECKPOINT", checkpoint.id, existing, checkpoint);
    return ok({ checkpoint });
  } catch (e) {
    return handleApiError(e);
  }
}
