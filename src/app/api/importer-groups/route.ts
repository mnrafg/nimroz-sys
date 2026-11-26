import { z } from "zod";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/auth";
import { fail, handleApiError, ok, readJson, requireUser } from "@/lib/api";
import { validateGroupRepresentative } from "@/lib/importer-groups";
import { allocateNumber, maxNumericSuffix } from "@/lib/sequences";
import { normalizeText } from "@/lib/normalize";
import { getAutomationSettings } from "@/lib/settings";
import { findIdempotentRecord, recordIdempotency } from "@/lib/idempotency";

/**
 * GET /api/importer-groups
 *
 * List of importer groups (گروپ‌های سازمانی واردکنندگان مرزی).
 * Master organizational data — readable by all authenticated users
 * (officers need it to assign border workers to existing groups);
 * changes are ADMIN-only. The representative is an existing registered
 * importer referenced by FK; no personal data is duplicated.
 */
export async function GET(request: Request) {
  try {
    const auth = await requireUser();
    if (auth.response) return auth.response;
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");

    const groups = await db.importerGroup.findMany({
      where: status ? { status } : {},
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        mandateDoc: true,
        undertakingDoc: true,
        status: true,
        createdAt: true,
        representative: {
          select: { id: true, name: true, importerCode: true },
        },
        _count: {
          select: {
            members: { where: { membershipStatus: "ACTIVE" } },
            subgroups: { where: { status: "ACTIVE" } },
          },
        },
      },
      orderBy: { code: "asc" },
    });

    return ok({ groups });
  } catch (e) {
    return handleApiError(e);
  }
}

const groupSchema = z.object({
  // SYSTEM-GENERATED identity — the group code is allocated by the server;
  // client-supplied values are ignored.
  code: z.string().nullable().optional(),
  name: z.string().min(2, "لطفاً نام گروپ را بنویسید."),
  // Group creation normally requires an eligible existing representative.
  representativeId: z.number({ message: "لطفاً نماینده مسئول گروپ را انتخاب کنید." }).int(),
  description: z.string().nullable().optional(),
  mandateDoc: z.string().nullable().optional(),
  undertakingDoc: z.string().nullable().optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
  idempotencyKey: z.string().nullable().optional(),
});

export async function POST(request: Request) {
  try {
    const auth = await requireUser(["ADMIN"]);
    if (auth.response) return auth.response;
    const parsed = await readJson(request, groupSchema);
    if (parsed.response) return parsed.response;
    const data = parsed.data;

    // IDEMPOTENT REPLAY — same request key returns the same created group.
    const replayId = await findIdempotentRecord(db, data.idempotencyKey, "IMPORTER_GROUP");
    if (replayId) {
      const existing = await db.importerGroup.findUnique({ where: { id: replayId } });
      if (existing) return ok({ group: existing, idempotentReplay: true });
    }

    const repError = await validateGroupRepresentative(data.representativeId ?? null);
    if (repError) return ok({ error: repError }, 400);

    const settings = await getAutomationSettings();
    const nameNorm = normalizeText(data.name);

    const created = await db.$transaction(async (tx) => {
      const groups = await tx.importerGroup.findMany({ select: { code: true, name: true } });
      // Normalized duplicate-name detection (letter variants unified).
      const dupName = groups.find((g) => normalizeText(g.name) === nameNorm);
      if (dupName) {
        throw new Error("DUPLICATE_NAME");
      }
      const code = await allocateNumber(tx, "GROUP", {
        prefix: settings.groupPrefix,
        pad: 2,
        seedFrom: maxNumericSuffix(groups.map((g) => g.code), settings.groupPrefix),
        exists: async (candidate) =>
          Boolean(await tx.importerGroup.findUnique({ where: { code: candidate }, select: { id: true } })),
      });
      const group = await tx.importerGroup.create({
        data: {
          code,
          name: data.name.trim(),
          representativeId: data.representativeId ?? null,
          description: data.description?.trim() || null,
          mandateDoc: data.mandateDoc?.trim() || null,
          undertakingDoc: data.undertakingDoc?.trim() || null,
          status: data.status,
        },
        include: { representative: { select: { id: true, name: true, importerCode: true } } },
      });
      await recordIdempotency(tx, data.idempotencyKey, "IMPORTER_GROUP", group.id);
      return group;
    });

    await logAudit(auth.user.id, "CREATE", "IMPORTER_GROUP", created.id, null, created);
    return ok({ group: created }, 201);
  } catch (e) {
    if (e instanceof Error && e.message === "DUPLICATE_NAME") {
      return fail("گروپی با این نام از قبل ثبت شده است.", 409);
    }
    return handleApiError(e);
  }
}
