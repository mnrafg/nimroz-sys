import { z } from "zod";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/auth";
import { fail, handleApiError, ok, readJson, requireUser } from "@/lib/api";
import { allocateNumber, maxNumericSuffix } from "@/lib/sequences";
import { normalizeText } from "@/lib/normalize";
import { getAutomationSettings } from "@/lib/settings";

export async function GET(request: Request) {
  try {
    const auth = await requireUser();
    if (auth.response) return auth.response;
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const uoms = await db.uom.findMany({
      where: status ? { status } : {},
      include: { _count: { select: { items: true } } },
      orderBy: { code: "asc" },
    });
    return ok({ uoms });
  } catch (e) {
    return handleApiError(e);
  }
}

const uomSchema = z.object({
  // OFFICIAL/standard code (LTR, KGM, TON …) — optional external reference.
  // When left blank an INTERNAL code is generated automatically (UOM-nnn).
  code: z.string().nullable().optional(),
  name: z.string().min(2, "لطفاً نام واحد را بنویسید."),
  symbol: z.string().min(1, "لطفاً علامت واحد را بنویسید."),
  status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
  idempotencyKey: z.string().nullable().optional(),
});

export async function POST(request: Request) {
  try {
    const auth = await requireUser(["ADMIN"]);
    if (auth.response) return auth.response;
    const parsed = await readJson(request, uomSchema);
    if (parsed.response) return parsed.response;
    const data = parsed.data;

    const settings = await getAutomationSettings();
    const nameNorm = normalizeText(data.name);

    const existingUoms = await db.uom.findMany({ select: { code: true, name: true } });
    const dupName = existingUoms.find((u) => normalizeText(u.name) === nameNorm);
    if (dupName) return fail("واحدی با این نام از قبل ثبت شده است.", 409);

    const officialCode = data.code?.trim().toUpperCase() || null;
    if (officialCode && existingUoms.some((u) => u.code.toUpperCase() === officialCode)) {
      return fail("این کود واحد از قبل موجود است.", 409);
    }

    const created = await db.$transaction(async (tx) => {
      let code = officialCode;
      if (!code) {
        code = await allocateNumber(tx, "UOM", {
          prefix: settings.uomPrefix,
          pad: 2,
          seedFrom: maxNumericSuffix(existingUoms.map((u) => u.code), settings.uomPrefix),
          exists: async (candidate) =>
            Boolean(await tx.uom.findUnique({ where: { code: candidate }, select: { id: true } })),
        });
      }
      const uom = await tx.uom.create({
        data: {
          code,
          name: data.name.trim(),
          symbol: data.symbol.trim(),
          status: data.status,
        },
      });
      return uom;
    });
    await logAudit(auth.user.id, "CREATE", "UOM", created.id, null, created);
    return ok({ uom: created }, 201);
  } catch (e) {
    return handleApiError(e);
  }
}
