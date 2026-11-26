import { z } from "zod";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/auth";
import { fail, handleApiError, ok, readJson, requireUser } from "@/lib/api";
import { importerVisibilityWhere, portScopeFor, NO_PORT_MESSAGE } from "@/lib/scope";
import { validateGroupAssignment } from "@/lib/importer-groups";
import { allocateNumber, maxNumericSuffix } from "@/lib/sequences";
import { normalizeIdentifier, normalizeText } from "@/lib/normalize";
import { getAutomationSettings } from "@/lib/settings";
import { findIdempotentRecord, recordIdempotency } from "@/lib/idempotency";

export async function GET(request: Request) {
  try {
    const auth = await requireUser();
    if (auth.response) return auth.response;
    // Central registry BROWSING is scoped: admins see everything; port
    // users see identities registered at their port, centrally registered
    // identities, or identities active at their port; non-admins without
    // an assigned port receive no registry data at all.
    const visibility = importerVisibilityWhere(auth.user);
    if (visibility === null) return fail(NO_PORT_MESSAGE, 403);
    const scope = portScopeFor(auth.user);
    const { searchParams } = new URL(request.url);
    const q = searchParams.get("q")?.trim();
    const status = searchParams.get("status");
    const type = searchParams.get("type");
    const groupId = searchParams.get("groupId");
    const subgroupId = searchParams.get("subgroupId");

    // Importer master data is centralized (single identity system), but
    // OPERATIONAL counters and history are port-scoped for non-admins.
    // For port-less non-admins no operational data is exposed at all.
    const operationalEntryWhere =
      scope.kind === "port"
        ? { checkpointId: scope.checkpointId }
        : scope.kind === "none"
          ? { id: { in: [] } }
          : {};

    const importers = await db.importer.findMany({
      where: {
        AND: [
          // Server-enforced registry visibility — client filters can only
          // narrow it, never widen it.
          visibility,
          q
            ? {
                // Digit variants unified for identifier search; names match
                // both the raw and normalized (Yeh/Kaf variants) spelling.
                OR: [
                  { name: { contains: q } },
                  { companyName: { contains: q } },
                  { importerCode: { contains: q } },
                  { licenseNumber: { contains: q } },
                  { tazkiraNumber: { contains: q } },
                  { idCardNumber: { contains: q } },
                ],
              }
            : {},
          status ? { status } : {},
          type ? { importerType: type } : {},
          groupId ? { groupId: Number(groupId) } : {},
          subgroupId ? { subgroupId: Number(subgroupId) } : {},
        ],
      },
      // Explicit select — photo blobs are NEVER transferred in list responses;
      // they are served through the dedicated /photo endpoint.
      select: {
        id: true,
        importerCode: true,
        name: true,
        fatherName: true,
        tazkiraNumber: true,
        province: true,
        idCardNumber: true,
        biometricStatus: true,
        biometricEnrolledAt: true,
        companyName: true,
        licenseNumber: true,
        phone: true,
        address: true,
        status: true,
        remarks: true,
        importerType: true,
        membershipStatus: true,
        registeredCheckpointId: true,
        registeredCheckpoint: { select: { id: true, name: true } },
        groupId: true,
        subgroupId: true,
        group: {
          select: {
            id: true,
            code: true,
            name: true,
            representative: { select: { id: true, name: true, importerCode: true } },
          },
        },
        subgroup: { select: { id: true, code: true, name: true } },
        _count: { select: { limits: true, entries: { where: operationalEntryWhere } } },
        entries: {
          where: { ...operationalEntryWhere, status: "APPROVED" },
          select: { importDatetime: true },
          orderBy: { importDatetime: "desc" },
          take: 1,
        },
      },
      orderBy: { importerCode: "asc" },
    });
    const importersClean = importers.map((i) => ({
      id: i.id,
      importerCode: i.importerCode,
      name: i.name,
      fatherName: i.fatherName,
      tazkiraNumber: i.tazkiraNumber,
      province: i.province,
      idCardNumber: i.idCardNumber,
      biometricStatus: i.biometricStatus,
      biometricEnrolledAt: i.biometricEnrolledAt,
      companyName: i.companyName,
      licenseNumber: i.licenseNumber,
      phone: i.phone,
      address: i.address,
      status: i.status,
      remarks: i.remarks,
      importerType: i.importerType,
      membershipStatus: i.membershipStatus,
      registeredCheckpointId: i.registeredCheckpointId,
      registeredCheckpointName: i.registeredCheckpoint?.name ?? null,
      groupId: i.groupId,
      group: i.group,
      subgroup: i.subgroup,
      // نماینده گروپ flag — TRUE when this importer is the OFFICIAL
      // representative of its group (group.representative → this row).
      isGroupRepresentative: i.group?.representative?.id === i.id,
      _count: { limits: i._count.limits, entries: i._count.entries },
      lastApprovedAt: i.entries?.[0]?.importDatetime ?? null,
    }));
    // V11 fix — the photo-existence index is derived from the SAME scoped
    // visibility query, never from a nationwide raw table scan.
    const photoVisible = await db.importer.findMany({
      where: { photoData: { not: null }, ...(visibility as object) },
      select: { id: true },
    });
    const photoIds = new Set(photoVisible.map((r) => r.id));
    return ok({ importers: importersClean.map((i) => ({ ...i, hasPhoto: photoIds.has(i.id) })) });
  } catch (e) {
    return handleApiError(e);
  }
}

const importerSchema = z.object({
  // SYSTEM-GENERATED identity — the client NEVER supplies the importer
  // number or card number. Any value sent here is ignored.
  importerCode: z.string().nullable().optional(),
  name: z.string().min(2, "لطفاً نام واردکننده را بنویسید."),
  fatherName: z.string().nullable().optional(),
  tazkiraNumber: z.string().nullable().optional(),
  province: z.string().nullable().optional(),
  idCardNumber: z.string().nullable().optional(),
  // V13 fix — base64 JPEG cap (~1.9 MB binary). Uploads are client-resized;
  // this is the server-side backstop against storage abuse.
  photoData: z
    .string()
    .max(2_600_000, "حجم عکس بیش از حد مجاز است؛ لطفاً عکس کوچک‌تر انتخاب کنید.")
    .nullable()
    .optional(),
  companyName: z.string().nullable().optional(),
  licenseNumber: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
  remarks: z.string().nullable().optional(),
  // Group organization (border-import regulation) — optional for commercial
  // importers, group is required for registered border workers.
  importerType: z.enum(["BORDER_WORKER", "COMMERCIAL"]).default("COMMERCIAL"),
  groupId: z.number().int().nullable().optional(),
  subgroupId: z.number().int().nullable().optional(),
  membershipStatus: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
  // Registration-port ownership — ADMIN-only input; officers are always
  // registered at their own assigned port (never trusted from the client).
  registeredCheckpointId: z.number().int().nullable().optional(),
  // Client-generated retry key — resubmitting the SAME request replays the
  // SAME created importer instead of creating a duplicate identity.
  idempotencyKey: z.string().nullable().optional(),
});

export async function POST(request: Request) {
  try {
    const auth = await requireUser(["ADMIN", "OFFICER"]);
    if (auth.response) return auth.response;
    const parsed = await readJson(request, importerSchema);
    if (parsed.response) return parsed.response;
    const data = parsed.data;

    // IDEMPOTENT REPLAY — same request key returns the same created record.
    const replayId = await findIdempotentRecord(db, data.idempotencyKey, "IMPORTER");
    if (replayId) {
      const existing = await db.importer.findUnique({ where: { id: replayId } });
      if (existing) return ok({ importer: { ...existing, photoData: undefined }, idempotentReplay: true });
    }

    // Registration-port ownership is decided SERVER-SIDE:
    //  - OFFICER → forced to the authenticated officer's assigned port;
    //    an officer without a port cannot register importers at all.
    //  - ADMIN   → may pass an explicit port; default null = centrally
    //    registered (visible to every port).
    let registeredCheckpointId: number | null = null;
    if (auth.user.role === "OFFICER") {
      if (!auth.user.checkpointId) return fail(NO_PORT_MESSAGE, 403);
      registeredCheckpointId = auth.user.checkpointId;
    } else if (data.registeredCheckpointId != null) {
      const cp = await db.borderCheckpoint.findUnique({
        where: { id: data.registeredCheckpointId },
      });
      if (!cp) return fail("بندر ثبت انتخاب‌شده موجود نیست.", 400);
      registeredCheckpointId = data.registeredCheckpointId;
    }

    const settings = await getAutomationSettings();

    // Central duplicate pre-checks — normalized digit/letter variants are
    // compared for Tazkira / card / license (indexed normalized columns);
    // names and phones are SUPPORTING signals only (shown by
    // /api/importers/duplicates, never hard-blocked — two people may
    // legitimately share a name or phone). Card numbers are SYSTEM-generated
    // so no client card collision is possible.
    const tazNorm = data.tazkiraNumber ? normalizeIdentifier(data.tazkiraNumber) : null;
    const licNorm = data.licenseNumber ? normalizeIdentifier(data.licenseNumber) : null;
    if (tazNorm) {
      const dupTaz = await db.importer.findFirst({ where: { tazkiraNormalized: tazNorm } });
      if (dupTaz) {
        return fail("این نمبر تذکره از قبل برای واردکننده دیگری ثبت شده است؛ ثبت دوم (دوباره‌گی) ممکن نیست.", 409);
      }
    }
    if (licNorm) {
      const dupLic = await db.importer.findFirst({
        where: { licenseNormalized: licNorm, importerType: "COMMERCIAL" },
      });
      if (dupLic) {
        return fail("این نمبر جواز تجارتی از قبل برای شرکت دیگری ثبت شده است.", 409);
      }
    }

    // Identity-triplet uniqueness — نام + نام پدر + شماره تماس together
    // identify ONE person. All three are compared normalized (letter/digit
    // variants and whitespace unified); a full match blocks a second
    // registration so duplicate identities can never be created quietly.
    const nameNorm = normalizeText(data.name);
    const fatherNorm = data.fatherName ? normalizeText(data.fatherName) : null;
    const phoneNorm = data.phone ? normalizeIdentifier(data.phone) : null;
    if (nameNorm && fatherNorm && phoneNorm) {
      const candidates = await db.importer.findMany({
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

    const groupError = await validateGroupAssignment({
      importerType: data.importerType,
      groupId: data.groupId ?? null,
      subgroupId: data.subgroupId ?? null,
    });
    if (groupError) return ok({ error: groupError }, 400);

    // SYSTEM-GENERATED identifiers (server-side, inside the transaction):
    //  - importer number: durable IMP sequence, seeded above every number
    //    ever issued (client-supplied values are IGNORED);
    //  - identification card number: AOGC-IC convention, also automatic.
    const created = await db.$transaction(async (tx) => {
      const existingCodes = await tx.importer.findMany({
        select: { importerCode: true, idCardNumber: true },
      });
      const importerCode = await allocateNumber(tx, "IMPORTER", {
        prefix: settings.importerPrefix,
        pad: 3,
        seedFrom: maxNumericSuffix(existingCodes.map((c) => c.importerCode), settings.importerPrefix),
        exists: async (candidate) =>
          Boolean(await tx.importer.findUnique({ where: { importerCode: candidate }, select: { id: true } })),
      });
      const idCardNumber = await allocateNumber(tx, "CARD", {
        prefix: settings.cardPrefix,
        pad: 4,
        seedFrom: maxNumericSuffix(
          existingCodes.map((c) => c.idCardNumber ?? ""),
          settings.cardPrefix
        ),
        exists: async (candidate) =>
          Boolean(await tx.importer.findUnique({ where: { idCardNumber: candidate }, select: { id: true } })),
      });

      const importer = await tx.importer.create({
        data: {
          importerCode,
          idCardNumber,
          name: data.name.trim(),
          fatherName: data.fatherName?.trim() || null,
          tazkiraNumber: data.tazkiraNumber?.trim() || null,
          tazkiraNormalized: tazNorm || null,
          licenseNormalized: licNorm || null,
          province: data.province?.trim() || null,
          photoData: data.photoData ?? null,
          companyName: data.companyName?.trim() || null,
          licenseNumber: data.licenseNumber?.trim() || null,
          phone: data.phone?.trim() || null,
          address: data.address?.trim() || null,
          status: data.status,
          remarks: data.remarks?.trim() || null,
          importerType: data.importerType,
          groupId: data.groupId ?? null,
          subgroupId: data.subgroupId ?? null,
          membershipStatus: data.groupId ? data.membershipStatus : "ACTIVE",
          registeredCheckpointId,
        },
      });
      await recordIdempotency(tx, data.idempotencyKey, "IMPORTER", importer.id);
      await tx.auditLog.create({
        data: {
          userId: auth.user.id,
          action: "CREATE",
          recordType: "IMPORTER",
          recordId: importer.id,
          newValues: JSON.stringify({ ...importer, photoData: importer.photoData ? "<photo>" : null }),
        },
      });
      return importer;
    });

    return ok({ importer: { ...created, photoData: undefined } }, 201);
  } catch (e) {
    return handleApiError(e);
  }
}
