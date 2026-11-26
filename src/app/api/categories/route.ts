import { z } from "zod";
import { db } from "@/lib/db";
import { fail, handleApiError, ok, readJson, requireUser } from "@/lib/api";
import { normalizeText } from "@/lib/normalize";

export async function GET() {
  try {
    const auth = await requireUser();
    if (auth.response) return auth.response;
    const categories = await db.itemCategory.findMany({
      orderBy: { name: "asc" },
    });
    return ok({ categories });
  } catch (e) {
    return handleApiError(e);
  }
}

const catSchema = z.object({
  name: z.string().min(2, "نام دسته باید حداقل دو حرف باشد."),
  status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
});

export async function POST(request: Request) {
  try {
    const auth = await requireUser(["ADMIN"]);
    if (auth.response) return auth.response;
    const parsed = await readJson(request, catSchema);
    if (parsed.response) return parsed.response;

    // Normalized duplicate-name detection (letter variants unified).
    const nameNorm = normalizeText(parsed.data.name);
    const existing = await db.itemCategory.findMany({ select: { name: true } });
    if (existing.some((c) => normalizeText(c.name) === nameNorm)) {
      return fail("دسته‌ای با این نام از قبل ثبت شده است.", 409);
    }

    const category = await db.itemCategory.create({ data: parsed.data });
    return ok({ category }, 201);
  } catch (e) {
    return handleApiError(e);
  }
}
