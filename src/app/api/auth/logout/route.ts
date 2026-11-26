import { getSessionUser, logAudit, SESSION_COOKIE } from "@/lib/auth";
import { ok } from "@/lib/api";

export async function POST() {
  const user = await getSessionUser();
  if (user) {
    await logAudit(user.id, "LOGOUT", "USER", user.id).catch(() => {});
  }
  const response = ok({ success: true });
  response.headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
  );
  return response;
}
