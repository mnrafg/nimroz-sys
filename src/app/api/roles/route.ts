import { db } from "@/lib/db";
import { handleApiError, ok, requireUser } from "@/lib/api";

export async function GET() {
  try {
    const auth = await requireUser();
    if (auth.response) return auth.response;
    // Only TWO roles exist: ADMIN and OFFICER (the supervisor role was
    // migrated away). Defense-in-depth: filter, never expose legacy roles.
    const roles = await db.role.findMany({
      where: { name: { in: ["ADMIN", "OFFICER"] } },
      orderBy: { id: "asc" },
    });
    return ok({ roles });
  } catch (e) {
    return handleApiError(e);
  }
}
