import { z } from "zod";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/auth";
import { fail, handleApiError, ok, readJson, requireUser } from "@/lib/api";
import { allocateNumber, maxNumericSuffix } from "@/lib/sequences";
import { normalizeText } from "@/lib/normalize";
import { getAutomationSettings } from "@/lib/settings";
import { findIdempotentRecord, recordIdempotency } from "@/lib/idempotency";

export async function GET(request: Request) {
  try {
    const auth = await requireUser();
    if (auth.response) return auth.response;
    const { searchParams } = new URL(request.url);
    const q = searchParams.get("q")?.trim();
    const status = searchParams.get("status");
    const items = await db.item.findMany({
      where: {
        AND: [
          q
            ? {
                OR: [
                  { itemName: { contains: q } },
                  { itemCode: { contains: q } },
                  { description: { contains: q } },
                ],
              }
            : {},
          status ? { status } : {},
        ],
      },
      include: { category: true, baseUom: true, _count: { select: { entryItems: true, restrictLimits: true } } },
      orderBy: { itemCode: "asc" },
    });
    return ok({ items });
  } catch (e) {
    return handleApiError(e);
  }
}

const itemSchema = z.object({
  // OFFICIAL code (FUEL-092, DSL-001 …) — optional external reference.
  // When left blank an INTERNAL code is generated automatically (ITM-nnn);
  // official codes are never invented from item names.
  itemCode: z.string().nullable().optional(),
  itemName: z.string().min(2, "لطفاً نام جنس را بنویسید."),
  categoryId: z.number().int().nullable().optional(),
  baseUomId: z.number({ message: "لطفاً واحد اساس را انتخاب کنید." }).int(),
  status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
  description: z.string().nullable().optional(),
  idempotencyKey: z.string().nullable().optional(),
});

export async function POST(request: Request) {
  try {
    const auth = await requireUser(["ADMIN"]);
    if (auth.response) return auth.response;
    const parsed = await readJson(request, itemSchema);
    if (parsed.response) return parsed.response;
    const data = parsed.data;

    // IDEMPOTENT REPLAY — same request key returns the same created item.
    const replayId = await findIdempotentRecord(db, data.idempotencyKey, "ITEM");
    if (replayId) {
      const existing = await db.item.findUnique({ where: { id: replayId } });
      if (existing) return ok({ item: existing, idempotentReplay: true });
    }

    const settings = await getAutomationSettings();
    const nameNorm = normalizeText(data.itemName);

    // Normalized duplicate detection: names match regardless of Persian/
    // Arabic letter or digit variants; codes compare case-insensitively.
    const existingItems = await db.item.findMany({ select: { itemCode: true, itemName: true } });
    const dupName = existingItems.find((i) => normalizeText(i.itemName) === nameNorm);
    if (dupName) return fail("جنسی با این نام از قبل ثبت شده است.", 409);

    const officialCode = data.itemCode?.trim().toUpperCase() || null;
    if (officialCode && existingItems.some((i) => i.itemCode.toUpperCase() === officialCode)) {
      return fail("این کود جنس از قبل موجود است.", 409);
    }

    // Active base UOM guard — flagging inactive base units up front keeps
    // the catalog consistent for registration.
    const baseUom = await db.uom.findUnique({ where: { id: data.baseUomId } });
    if (!baseUom) return fail("واحد اساس انتخاب‌شده موجود نیست.", 400);

    const created = await db.$transaction(async (tx) => {
      let itemCode = officialCode;
      if (!itemCode) {
        itemCode = await allocateNumber(tx, "ITEM", {
          prefix: settings.itemPrefix,
          pad: 3,
          seedFrom: maxNumericSuffix(existingItems.map((i) => i.itemCode), settings.itemPrefix),
          exists: async (candidate) =>
            Boolean(await tx.item.findUnique({ where: { itemCode: candidate }, select: { id: true } })),
        });
      }
      const item = await tx.item.create({
        data: {
          itemCode,
          itemName: data.itemName.trim(),
          categoryId: data.categoryId ?? null,
          baseUomId: data.baseUomId,
          status: data.status,
          description: data.description?.trim() || null,
        },
      });
      await recordIdempotency(tx, data.idempotencyKey, "ITEM", item.id);
      return item;
    });
    await logAudit(auth.user.id, "CREATE", "ITEM", created.id, null, created);
    return ok({ item: created }, 201);
  } catch (e) {
    return handleApiError(e);
  }
}
