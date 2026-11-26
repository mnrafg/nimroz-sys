import { z } from "zod";
import { db } from "@/lib/db";
import { hashPassword, logAudit } from "@/lib/auth";
import { fail, handleApiError, ok, readJson, requireUser, validatePasswordStrength } from "@/lib/api";

/** Roles that are bound to a specific border port. */
const PORT_BOUND_ROLES = ["OFFICER"];

async function validateRoleAndCheckpoint(roleId: number, checkpointId: number | null | undefined) {
  const role = await db.role.findUnique({ where: { id: roleId } });
  if (!role) return "صلاحیت انتخاب‌شده موجود نیست.";
  if (checkpointId !== null && checkpointId !== undefined) {
    const cp = await db.borderCheckpoint.findUnique({ where: { id: checkpointId } });
    if (!cp) return "بندر انتخاب‌شده موجود نیست.";
  }
  // Port-bound roles MUST have an assigned port — no nationwide fallback.
  if (PORT_BOUND_ROLES.includes(role.name) && !checkpointId) {
    return `برای صلاحیت «${role.nameDari}» تخصیص بندر ضروری است؛ حساب بدون بندر هیچ معلوماتی دریافت نمی‌کند.`;
  }
  return null;
}

const userSelect = {
  id: true,
  name: true,
  email: true,
  roleId: true,
  checkpointId: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  role: true,
  checkpoint: true,
  _count: { select: { entriesCreated: true } },
} as const;

export async function GET() {
  try {
    const auth = await requireUser(["ADMIN"]);
    if (auth.response) return auth.response;
    const users = await db.user.findMany({
      // Credentials never leave the server — password hashes are not exposed.
      select: userSelect,
      orderBy: { id: "asc" },
    });
    return ok({ users });
  } catch (e) {
    return handleApiError(e);
  }
}

const userSchema = z.object({
  name: z.string().min(2, "لطفاً نام کاربر را بنویسید."),
  email: z.string().email("ایمیل نامعتبر است."),
  password: z.string().min(1, "لطفاً پاسورد را بنویسید."),
  roleId: z.number({ message: "لطفاً صلاحیت کاربر را انتخاب کنید." }).int(),
  checkpointId: z.number().int().nullable().optional(),
  isActive: z.boolean().default(true),
});

export async function POST(request: Request) {
  try {
    const auth = await requireUser(["ADMIN"]);
    if (auth.response) return auth.response;
    const parsed = await readJson(request, userSchema);
    if (parsed.response) return parsed.response;

    const pwError = validatePasswordStrength(parsed.data.password, parsed.data.email);
    if (pwError) return fail(pwError, 400);

    const roleError = await validateRoleAndCheckpoint(parsed.data.roleId, parsed.data.checkpointId);
    if (roleError) return fail(roleError, 400);

    const user = await db.user.create({
      data: {
        name: parsed.data.name.trim(),
        email: parsed.data.email.trim().toLowerCase(),
        passwordHash: await hashPassword(parsed.data.password),
        roleId: parsed.data.roleId,
        checkpointId: parsed.data.checkpointId ?? null,
        isActive: parsed.data.isActive,
      },
      select: userSelect,
    });
    await logAudit(auth.user.id, "CREATE", "USER", user.id, null, user);
    return ok({ user }, 201);
  } catch (e) {
    return handleApiError(e);
  }
}
