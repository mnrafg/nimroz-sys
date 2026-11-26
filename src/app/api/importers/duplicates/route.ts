import { db } from "@/lib/db";
import { handleApiError, ok, requireUser } from "@/lib/api";
import { importerVisibilityWhere, portScopeFor } from "@/lib/scope";
import { normalizeIdentifier, stripLeadingZeros } from "@/lib/normalize";

/**
 * GET /api/importers/duplicates?tazkira=&idCard=&license=&excludeId=
 *
 * Pre-save duplicate signals for the importer registration form — HARD
 * identity documents only (Tazkira / card / license; digit variants
 * unified, leading zeros ignored for comparison).
 *
 * A typed NAME (or father name) intentionally NEVER triggers this
 * warning: names are not identity, partial-name matches are noise, and
 * exact name+father+phone duplicates are hard-blocked at SAVE time by
 * the create/update routes' triplet check.
 *
 * Only importers inside the caller's registry scope are ever returned.
 */
export async function GET(request: Request) {
  try {
    const auth = await requireUser();
    if (auth.response) return auth.response;
    const visibility = importerVisibilityWhere(auth.user);
    if (visibility === null) return ok({ matches: [] });
    const scope = portScopeFor(auth.user);

    const { searchParams } = new URL(request.url);
    const tazkira = searchParams.get("tazkira")?.trim();
    const idCard = searchParams.get("idCard")?.trim();
    const license = searchParams.get("license")?.trim();
    const excludeId = searchParams.get("excludeId") ? Number(searchParams.get("excludeId")) : null;

    if (!tazkira && !idCard && !license) {
      return ok({ matches: [] });
    }

    // Restrictive candidate filter from the hard signals first.
    const hardWhere: Record<string, unknown>[] = [];
    if (tazkira) {
      const t = normalizeIdentifier(tazkira);
      if (t) hardWhere.push({ OR: [{ tazkiraNormalized: t }, { tazkiraNormalized: stripLeadingZeros(t) }] });
    }
    if (idCard) hardWhere.push({ idCardNumber: idCard });
    if (license) {
      const l = normalizeIdentifier(license);
      if (l) hardWhere.push({ OR: [{ licenseNormalized: l }, { licenseNormalized: stripLeadingZeros(l) }] });
    }

    const candidates = await db.importer.findMany({
      where: {
        AND: [
          visibility as object,
          ...(excludeId ? [{ id: { not: excludeId } }] : []),
          ...(hardWhere.length ? [{ OR: hardWhere }] : []),
        ],
      },
      select: {
        id: true,
        importerCode: true,
        name: true,
        companyName: true,
        phone: true,
        importerType: true,
        status: true,
        tazkiraNumber: true,
        idCardNumber: true,
        licenseNumber: true,
        registeredCheckpoint: { select: { name: true } },
      },
      take: 10,
    });

    const tazN = tazkira ? normalizeIdentifier(tazkira) : null;
    const tazNz = tazN ? stripLeadingZeros(tazN) : null;
    const licN = license ? normalizeIdentifier(license) : null;
    const licNz = licN ? stripLeadingZeros(licN) : null;

    const matches = candidates.map((c) => {
      const matchedOn: string[] = [];
      const cTaz = c.tazkiraNumber ? normalizeIdentifier(c.tazkiraNumber) : null;
      if (tazN && cTaz && (cTaz === tazN || (tazNz && cTaz === tazNz))) matchedOn.push("تذکره");
      if (idCard && c.idCardNumber && c.idCardNumber.trim() === idCard.trim()) matchedOn.push("کارت شناسایی");
      const cLic = c.licenseNumber ? normalizeIdentifier(c.licenseNumber) : null;
      if (licN && cLic && (cLic === licN || (licNz && cLic === licNz))) matchedOn.push("جواز");
      return { ...c, matchedOn, hard: true };
    });

    return ok({ matches, scope: scope.kind });
  } catch (e) {
    return handleApiError(e);
  }
}
