import { z } from "zod";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/auth";
import { handleApiError, ok, readJson, requireUser } from "@/lib/api";

/**
 * PUT /api/importer-subgroups/[id] — ADMIN only.
 * Update a subgroup (code, name, status, optionally move to another
 * parent group — validated). Deliberately minimal by design.
 */
const subgroupUpdateSchema = z.object({
  // SYSTEM-OWNED identity — subgroup codes are server-allocated (parent-based
  // sequence) and immutable.
  code: z.string().optional(),
  name: z.string().min(2).optional(),
  groupId: z.number().int().optional(),
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
    const subgroupId = Number(id);
    const existing = await db.importerSubgroup.findUnique({ where: { id: subgroupId } });
    if (!existing) return ok({ error: "زیرگروپ مورد نظر پیدا نشد." }, 404);

    const parsed = await readJson(request, subgroupUpdateSchema);
    if (parsed.response) return parsed.response;
    const data = parsed.data;

    // SYSTEM-OWNED IDENTIFIER — subgroup codes never change via API requests.
    if (data.code !== undefined && data.code?.trim().toUpperCase() !== existing.code.toUpperCase()) {
      return ok({ error: "کود زیرگروپ توسط سیستم تولید می‌شود و قابل تغییر نیست." }, 400);
    }
    delete data.code;

    if (data.groupId !== undefined && data.groupId !== existing.groupId) {
      const group = await db.importerGroup.findUnique({ where: { id: data.groupId } });
      if (!group) return ok({ error: "گروپ مقصد موجود نیست." }, 400);
    }

    const subgroup = await db.importerSubgroup.update({
      where: { id: subgroupId },
      data: {
        name: data.name?.trim(),
        groupId: data.groupId,
        status: data.status,
      },
    });
    await logAudit(
      auth.user.id,
      existing.status !== subgroup.status ? "STATUS_CHANGE" : "UPDATE",
      "IMPORTER_SUBGROUP",
      subgroup.id,
      existing,
      subgroup
    );
    return ok({ subgroup });
  } catch (e) {
    return handleApiError(e);
  }
}
