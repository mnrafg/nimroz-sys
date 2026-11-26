import { getSessionUser } from "@/lib/auth";
import { fail, ok } from "@/lib/api";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail("نشست فعال نیست.", 401);
  return ok({ user });
}
