import { z } from "zod";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/auth";
import { fail, handleApiError, ok, readJson, requireUser } from "@/lib/api";
import { portScopeFor } from "@/lib/scope";
import { allocateNumber, maxNumericSuffix } from "@/lib/sequences";
import { normalizeText } from "@/lib/normalize";
import { getAutomationSettings } from "@/lib/settings";

export async function GET(request: Request) {
  try {
    const auth = await requireUser();
    if (auth.response) return auth.response;
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");

    // Port isolation on the checkpoint list itself:
    //  - admins see all ports (with operational counters)
    //  - port users see ONLY their assigned port (their own counters)
    //  - port-less non-admins receive no operational data (empty list)
    const scope = portScopeFor(auth.user);
    const scopeWhere =
      scope.kind === "port" ? { id: scope.checkpointId } : scope.kind === "none" ? { id: -1 } : {};
    const checkpoints = await db.borderCheckpoint.findMany({
      where: { AND: [status ? { status } : {}, scopeWhere] },
      include: { _count: { select: { users: true, entries: true, limits: true } } },
      orderBy: { code: "asc" },
    });
    return ok({ checkpoints });
  } catch (e) {
    return handleApiError(e);
  }
}

const cpSchema = z.object({
  // OFFICIAL abbreviation (TRK, HRT …) — optional external reference.
  // When left blank an INTERNAL code is generated automatically (CHP-nnn).
  code: z.string().nullable().optional(),
  name: z.string().min(2, "لطفاً نام بندر را بنویسید."),
  province: z.string().min(2, "لطفاً نام ولایت را بنویسید."),
  status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
  idempotencyKey: z.string().nullable().optional(),
});

export async function POST(request: Request) {
  try {
    const auth = await requireUser(["ADMIN"]);
    if (auth.response) return auth.response;
    const parsed = await readJson(request, cpSchema);
    if (parsed.response) return parsed.response;
    const data = parsed.data;

    const settings = await getAutomationSettings();
    const nameNorm = normalizeText(data.name);

    const existingCps = await db.borderCheckpoint.findMany({ select: { code: true, name: true } });
    const dupName = existingCps.find((c) => normalizeText(c.name) === nameNorm);
    if (dupName) return fail("بندری با این نام از قبل ثبت شده است.", 409);

    const officialCode = data.code?.trim().toUpperCase() || null;
    if (officialCode && existingCps.some((c) => c.code.toUpperCase() === officialCode)) {
      return fail("این کود بندر از قبل موجود است.", 409);
    }

    const created = await db.$transaction(async (tx) => {
      let code = officialCode;
      if (!code) {
        code = await allocateNumber(tx, "CHECKPOINT", {
          prefix: settings.checkpointPrefix,
          pad: 2,
          seedFrom: maxNumericSuffix(existingCps.map((c) => c.code), settings.checkpointPrefix),
          exists: async (candidate) =>
            Boolean(await tx.borderCheckpoint.findUnique({ where: { code: candidate }, select: { id: true } })),
        });
      }
      const checkpoint = await tx.borderCheckpoint.create({
        data: {
          code,
          name: data.name.trim(),
          province: data.province.trim(),
          status: data.status,
        },
      });
      return checkpoint;
    });
    await logAudit(auth.user.id, "CREATE", "CHECKPOINT", created.id, null, created);
    return ok({ checkpoint: created }, 201);
  } catch (e) {
    return handleApiError(e);
  }
}
