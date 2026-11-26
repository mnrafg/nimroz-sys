import { z } from "zod";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/auth";
import { fail, handleApiError, ok, readJson, requireUser } from "@/lib/api";
import { allocateNumber, maxNumericSuffix } from "@/lib/sequences";
import { normalizeText } from "@/lib/normalize";
import { findIdempotentRecord, recordIdempotency } from "@/lib/idempotency";

/**
 * GET /api/importer-groups/[id]/subgroups
 * List of a group's subgroups (readable by all authenticated users —
 * needed by the importer form's dependent subgroup dropdown).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireUser();
    if (auth.response) return auth.response;
    const { id } = await params;
    const groupId = Number(id);
    const group = await db.importerGroup.findUnique({ where: { id: groupId } });
    if (!group) return ok({ error: "گروپ مورد نظر پیدا نشد." }, 404);

    const subgroups = await db.importerSubgroup.findMany({
      where: { groupId },
      select: {
        id: true,
        code: true,
        name: true,
        status: true,
        _count: { select: { members: true } },
      },
      orderBy: { code: "asc" },
    });
    return ok({ subgroups });
  } catch (e) {
    return handleApiError(e);
  }
}

/**
 * POST /api/importer-groups/[id]/subgroups — ADMIN only.
 * Optional sub-organization under a group. The subgroup code is
 * SYSTEM-GENERATED with the parent-based convention GRP-{NN}-S{n}
 * (counter per parent group, seeded above every code already issued for
 * that group — legacy SUB-xx codes are untouched). The parent group is
 * implied by the URL and locked; the representative remains the group's
 * official representative (no second person record is created).
 */
const subgroupSchema = z.object({
  // SYSTEM-GENERATED identity — client values ignored.
  code: z.string().nullable().optional(),
  name: z.string().min(2, "لطفاً نام زیرگروپ را بنویسید."),
  status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
  idempotencyKey: z.string().nullable().optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireUser(["ADMIN"]);
    if (auth.response) return auth.response;
    const { id } = await params;
    const groupId = Number(id);
    const group = await db.importerGroup.findUnique({ where: { id: groupId } });
    if (!group) return ok({ error: "گروپ مورد نظر پیدا نشد." }, 404);

    const parsed = await readJson(request, subgroupSchema);
    if (parsed.response) return parsed.response;
    const data = parsed.data;

    // IDEMPOTENT REPLAY — same request key returns the same created subgroup.
    const replayId = await findIdempotentRecord(db, data.idempotencyKey, "IMPORTER_SUBGROUP");
    if (replayId) {
      const existing = await db.importerSubgroup.findUnique({ where: { id: replayId } });
      if (existing) return ok({ subgroup: existing, idempotentReplay: true });
    }

    const created = await db.$transaction(async (tx) => {
      const subs = await tx.importerSubgroup.findMany({
        where: { groupId },
        select: { code: true, name: true },
      });
      const nameNorm = normalizeText(data.name);
      const dupName = subs.find((s) => normalizeText(s.name) === nameNorm);
      if (dupName) throw new Error("DUPLICATE_NAME");

      // Parent-based sequence: GRP-03-S4 → next S5 for this group only.
      // The seed scan is limited to THIS group's own codes.
      const groupPrefix = `${group.code}-S`;
      const code = await allocateNumber(tx, `SUBGROUP:${groupId}`, {
        prefix: groupPrefix,
        pad: 1,
        seedFrom: maxNumericSuffix(subs.map((s) => s.code), groupPrefix),
        exists: async (candidate) =>
          Boolean(await tx.importerSubgroup.findUnique({ where: { code: candidate }, select: { id: true } })),
      });
      const subgroup = await tx.importerSubgroup.create({
        data: {
          code,
          name: data.name.trim(),
          groupId,
          status: data.status,
        },
      });
      await recordIdempotency(tx, data.idempotencyKey, "IMPORTER_SUBGROUP", subgroup.id);
      return subgroup;
    });

    await logAudit(auth.user.id, "CREATE", "IMPORTER_SUBGROUP", created.id, null, created);
    return ok({ subgroup: created }, 201);
  } catch (e) {
    if (e instanceof Error && e.message === "DUPLICATE_NAME") {
      return fail("زیرگروپی با این نام از قبل در این گروپ ثبت شده است.", 409);
    }
    return handleApiError(e);
  }
}
