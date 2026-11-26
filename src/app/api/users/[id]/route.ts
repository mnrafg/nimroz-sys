import { z } from "zod";
import { db } from "@/lib/db";
import { hashPassword, logAudit } from "@/lib/auth";
import { fail, handleApiError, ok, readJson, requireUser, validatePasswordStrength } from "@/lib/api";

/** Roles that are bound to a specific border port. */
const PORT_BOUND_ROLES = ["OFFICER"];

const userUpdateSchema = z.object({
  name: z.string().min(2).optional(),
  email: z.string().email("ایمیل نامعتبر است.").optional(),
  password: z.string().min(1).optional().or(z.literal("")),
  roleId: z.number().int().optional(),
  checkpointId: z.number().int().nullable().optional(),
  isActive: z.boolean().optional(),
});

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
} as const;

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireUser(["ADMIN"]);
    if (auth.response) return auth.response;
    const { id } = await params;
    const parsed = await readJson(request, userUpdateSchema);
    if (parsed.response) return parsed.response;

    const existing = await db.user.findUnique({ where: { id: Number(id) } });
    if (!existing) return ok({ error: "کاربر مورد نظر پیدا نشد." }, 404);

    const data = parsed.data;
    if (data.email) {
      const dupe = await db.user.findFirst({
        where: { email: data.email.trim().toLowerCase(), id: { not: Number(id) } },
      });
      if (dupe) return fail("این ایمیل برای کاربر دیگری ثبت شده است.", 409);
    }

    // Password policy (only when a new password is actually set). The email
    // is passed so the validator can reject passwords embedding the account
    // prefix (V16 fix).
    if (data.password) {
      const pwError = validatePasswordStrength(data.password, data.email ?? existing.email);
      if (pwError) return fail(pwError, 400);
    }

    // V9 fix — omitted fields keep their current value; an explicit null
    // port assignment is the ONLY way to unassign a port.
    const effectiveRoleId = data.roleId ?? existing.roleId;
    const effectiveCheckpointId =
      data.checkpointId === undefined ? existing.checkpointId : data.checkpointId;
    const role = await db.role.findUnique({ where: { id: effectiveRoleId } });
    if (!role) return fail("صلاحیت انتخاب‌شده موجود نیست.", 400);
    if (effectiveCheckpointId !== null) {
      const cp = await db.borderCheckpoint.findUnique({ where: { id: effectiveCheckpointId } });
      if (!cp) return fail("بندر انتخاب‌شده موجود نیست.", 400);
    }
    if (PORT_BOUND_ROLES.includes(role.name) && !effectiveCheckpointId) {
      return fail(
        `برای صلاحیت «${role.nameDari}» تخصیص بندر ضروری است؛ حساب بدون بندر هیچ معلوماتی دریافت نمی‌کند.`,
        400
      );
    }

    const user = await db.user.update({
      where: { id: Number(id) },
      data: {
        name: data.name?.trim(),
        email: data.email?.trim().toLowerCase(),
        passwordHash: data.password ? await hashPassword(data.password) : undefined,
        // V16 fix — stamp the change instant so every JWT issued before it
        // is rejected (immediate session revocation on password change).
        passwordChangedAt: data.password ? new Date() : undefined,
        roleId: data.roleId,
        checkpointId: data.checkpointId === undefined ? undefined : data.checkpointId,
        isActive: data.isActive,
      },
      select: userSelect,
    });
    await logAudit(auth.user.id, "UPDATE", "USER", user.id, null, user);
    return ok({ user });
  } catch (e) {
    return handleApiError(e);
  }
}
