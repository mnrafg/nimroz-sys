import { z } from "zod";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/auth";
import { fail, handleApiError, ok, readJson, requireUser } from "@/lib/api";
import { canViewImporter, canManageImporter, portScopeFor, importerScopeEvidence, NO_PORT_MESSAGE, CROSS_PORT_MESSAGE } from "@/lib/scope";
import { validateGroupAssignment } from "@/lib/importer-groups";
import { normalizeIdentifier, normalizeText } from "@/lib/normalize";

const importerUpdateSchema = z.object({
  // SYSTEM-OWNED identity — importer number and card number are immutable.
  // Attempts to change them are rejected outright.
  importerCode: z.string().optional(),
  name: z.string().min(2).optional(),
  fatherName: z.string().nullable().optional(),
  tazkiraNumber: z.string().nullable().optional(),
  province: z.string().nullable().optional(),
  idCardNumber: z.string().optional(),
  // V13 fix — same server-side photo size cap as on create.
  photoData: z
    .string()
    .max(2_600_000, "حجم عکس بیش از حد مجاز است؛ لطفاً عکس کوچک‌تر انتخاب کنید.")
    .nullable()
    .optional(),
  companyName: z.string().nullable().optional(),
  licenseNumber: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  remarks: z.string().nullable().optional(),
  importerType: z.enum(["BORDER_WORKER", "COMMERCIAL"]).optional(),
  groupId: z.number().int().nullable().optional(),
  subgroupId: z.number().int().nullable().optional(),
  membershipStatus: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireUser();
    if (auth.response) return auth.response;
    // A non-admin without an assigned port receives no registry data.
    if (portScopeFor(auth.user).kind === "none") {
      return fail(NO_PORT_MESSAGE, 403);
    }
    const { id } = await params;
    const importer = await db.importer.findUnique({
      where: { id: Number(id) },
      include: {
        _count: { select: { limits: true } },
        // Registry-visibility evidence (V4 fix) + group context.
        ...importerScopeEvidence,
        group: {
          select: {
            id: true,
            code: true,
            name: true,
            representative: { select: { id: true, name: true, importerCode: true } },
          },
        },
        subgroup: { select: { id: true, code: true, name: true } },
      },
    });
    if (!importer) return ok({ error: "واردکننده مورد نظر پیدا نشد." }, 404);
    // V4 fix — a port user may only fetch importers of their own registry
    // scope; by-ID enumeration of other ports' identities is rejected.
    if (!canViewImporter(auth.user, importer)) {
      return fail(CROSS_PORT_MESSAGE, 403);
    }
    const { entries: _e, limits: _l, ...importerClean } = importer;

    // Operational history is port-scoped: port users only see entries of
    // their own port; port-less non-admins see no operational history.
    const scope = portScopeFor(auth.user);
    const entries =
      scope.kind === "none"
        ? []
        : await db.importEntry.findMany({
            where: {
              importerId: Number(id),
              ...(scope.kind === "port" ? { checkpointId: scope.checkpointId } : {}),
            },
            include: {
              checkpoint: { select: { name: true } },
              items: { include: { item: { select: { itemName: true } }, uom: { select: { symbol: true } } } },
              creator: { select: { name: true } },
            },
            orderBy: { importDatetime: "desc" },
            take: 100,
          });
    return ok({
      importer: {
        ...importerClean,
        photoData: undefined,
        _count: {
          // V4 fix — quota count is operational data: port-scoped.
          limits:
            scope.kind === "all"
              ? importer._count.limits
              : scope.kind === "port"
                ? importer.limits.filter((l) => l.checkpointId === scope.checkpointId).length
                : 0,
          entries: entries.length,
        },
      },
      entries,
    });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireUser(["ADMIN", "OFFICER"]);
    if (auth.response) return auth.response;
    const { id } = await params;
    const parsed = await readJson(request, importerUpdateSchema);
    if (parsed.response) return parsed.response;

    const existing = await db.importer.findUnique({
      where: { id: Number(id) },
      include: {
        _count: { select: { limits: true } },
        // Ownership evidence used for the manage-authorization check below.
        ...importerScopeEvidence,
        group: {
          select: {
            id: true,
            code: true,
            name: true,
            representative: { select: { id: true, name: true, importerCode: true } },
          },
        },
        subgroup: { select: { id: true, code: true, name: true } },
      },
    });
    if (!existing) return ok({ error: "واردکننده مورد نظر پیدا نشد." }, 404);

    const data = parsed.data;

    // SYSTEM-OWNED IDENTIFIERS — importer number and card number can never
    // be changed through the API. Requests that try are rejected so silent
    // rewrites (including whitespace/case games) are impossible.
    if (data.importerCode !== undefined && data.importerCode?.trim().toUpperCase() !== existing.importerCode.toUpperCase()) {
      return fail("نمبر واردکننده توسط سیستم تولید می‌شود و قابل تغییر نیست.", 400);
    }
    if (data.idCardNumber !== undefined && data.idCardNumber?.trim() !== (existing.idCardNumber ?? "").trim()) {
      return fail("شماره کارت شناسایی توسط سیستم تولید می‌شود و قابل تغییر نیست.", 400);
    }
    delete data.importerCode;
    delete data.idCardNumber;

    // Tazkira duplicate check (normalized) — the record's own row is excluded.
    if (data.tazkiraNumber !== undefined) {
      const tazNorm = data.tazkiraNumber ? normalizeIdentifier(data.tazkiraNumber) : null;
      if (tazNorm) {
        const dup = await db.importer.findFirst({
          where: { tazkiraNormalized: tazNorm, id: { not: existing.id } },
        });
        if (dup) {
          return fail("این نمبر تذکره از قبل برای واردکننده دیگری ثبت شده است؛ ثبت دوم (دوباره‌گی) ممکن نیست.", 409);
        }
      }
    }
    if (data.licenseNumber !== undefined) {
      const licNorm = data.licenseNumber ? normalizeIdentifier(data.licenseNumber) : null;
      if (licNorm) {
        const dup = await db.importer.findFirst({
          where: { licenseNormalized: licNorm, importerType: "COMMERCIAL", id: { not: existing.id } },
        });
        if (dup) {
          return fail("این نمبر جواز تجارتی از قبل برای شرکت دیگری ثبت شده است.", 409);
        }
      }
    }

    // Identity-triplet uniqueness on update (نام + نام پدر + شماره تماس).
    // Effective values: what the client sent, falling back to what is stored.
    {
      const effName = data.name !== undefined ? data.name : existing.name;
      const effFather = data.fatherName !== undefined ? data.fatherName : existing.fatherName;
      const effPhone = data.phone !== undefined ? data.phone : existing.phone;
      const nameNorm = normalizeText(effName);
      const fatherNorm = effFather ? normalizeText(effFather) : null;
      const phoneNorm = effPhone ? normalizeIdentifier(effPhone) : null;
      if (nameNorm && fatherNorm && phoneNorm) {
        const candidates = await db.importer.findMany({
          where: { id: { not: existing.id } },
          select: { id: true, importerCode: true, name: true, fatherName: true, phone: true },
        });
        const dupTriplet = candidates.find(
          (c) =>
            normalizeText(c.name) === nameNorm &&
            normalizeText(c.fatherName) === fatherNorm &&
            normalizeIdentifier(c.phone) === phoneNorm
        );
        if (dupTriplet) {
          return fail(
            `ثبت دوباره‌گی: واردکننده‌ای با همین نام، نام پدر و شماره تماس از قبل موجود است (${dupTriplet.importerCode} — ${dupTriplet.name}).`,
            409
          );
        }
      }
    }

    // Master-identity edits are authorization-checked SERVER-SIDE: an
    // officer may only manage importers of their own scope (registered at
    // their port, centrally registered, or active at their port).
    if (!canManageImporter(auth.user, existing)) {
      return fail(CROSS_PORT_MESSAGE, 403);
    }

    // Group assignment rules — the resulting state is validated (subgroup
    // must belong to the selected group; border workers need a group).
    const effectiveType = data.importerType ?? existing.importerType;
    const effectiveGroupId = data.groupId === undefined ? existing.groupId : data.groupId;
    const effectiveSubgroupId = data.subgroupId === undefined ? existing.subgroupId : data.subgroupId;
    const groupError = await validateGroupAssignment({
      importerType: effectiveType,
      groupId: effectiveGroupId,
      subgroupId: effectiveSubgroupId,
    });
    if (groupError) return ok({ error: groupError }, 400);

    const importer = await db.importer.update({
      where: { id: Number(id) },
      data: {
        ...data,
        name: data.name?.trim(),
        fatherName: data.fatherName === undefined ? undefined : data.fatherName?.trim() || null,
        tazkiraNumber: data.tazkiraNumber === undefined ? undefined : data.tazkiraNumber?.trim() || null,
        tazkiraNormalized:
          data.tazkiraNumber === undefined
            ? undefined
            : data.tazkiraNumber
              ? normalizeIdentifier(data.tazkiraNumber) || null
              : null,
        licenseNormalized:
          data.licenseNumber === undefined
            ? undefined
            : data.licenseNumber
              ? normalizeIdentifier(data.licenseNumber) || null
              : null,
        province: data.province === undefined ? undefined : data.province?.trim() || null,
        // Clear subgroup when the membership is removed entirely.
        subgroupId: effectiveGroupId === null ? null : data.subgroupId,
        membershipStatus: effectiveGroupId === null ? "ACTIVE" : data.membershipStatus,
      },
    });
    await logAudit(
      auth.user.id,
      existing.status !== importer.status ? "STATUS_CHANGE" : "UPDATE",
      "IMPORTER",
      importer.id,
      { ...existing, photoData: existing.photoData ? "<photo>" : null },
      { ...importer, photoData: importer.photoData ? "<photo>" : null }
    );
    return ok({ importer: { ...importer, photoData: undefined } });
  } catch (e) {
    return handleApiError(e);
  }
}
