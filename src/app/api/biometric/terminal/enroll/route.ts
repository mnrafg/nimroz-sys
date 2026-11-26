import { z } from "zod";
import { ok, fail, requireUser, readJson, handleApiError, FriendlyApiError } from "@/lib/api";
import {
  startEnrollment,
  completeEnrollment,
  cancelEnrollment,
  expireStaleEnrollments,
  enrollmentRegistration,
} from "@/lib/biometric/terminal-enrollment";

// ============================================================
// POST /api/biometric/terminal/enroll
// Actions: start | complete | cancel | propose-user
//
// "Enrollment" means CONFIRMING an identity that was enrolled on the
// terminal itself. Completion links DEVICE SERIAL + TERMINAL USER ID
// to the importer only after ONE fresh matching biometric event —
// never via remote template capture.
// ============================================================

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("start"),
    importerId: z.number().int().positive(),
    deviceKey: z.string().min(4).max(64),
    terminalUserId: z.string().regex(/^[1-9][0-9]{0,8}$/, "شناسه کاربر دستگاه باید عدد مثبت با حداکثر ۹ رقم باشد."),
  }),
  z.object({
    action: z.literal("complete"),
    enrollmentId: z.string().uuid(),
    scanId: z.string().uuid(),
  }),
  z.object({
    action: z.literal("cancel"),
    enrollmentId: z.string().uuid(),
  }),
  z.object({
    action: z.literal("propose-user"),
    importerId: z.number().int().positive(),
    deviceKey: z.string().min(4).max(64),
  }),
]);

export async function POST(request: Request) {
  const auth = await requireUser(["ADMIN", "OFFICER"]);
  if (auth.response) return auth.response;
  const body = await readJson(request, schema);
  if (body.response) return body.response;
  try {
    await expireStaleEnrollments();
    const input = body.data;
    if (input.action === "propose-user") {
      const registration = await enrollmentRegistration(auth.user, input.deviceKey, input.importerId);
      return ok(registration);
    }
    if (input.action === "start") {
      const enrollment = await startEnrollment(auth.user, {
        importerId: input.importerId,
        deviceKey: input.deviceKey,
        terminalUserId: input.terminalUserId,
      });
      return ok({ enrollment });
    }
    if (input.action === "complete") {
      const result = await completeEnrollment(auth.user, input.enrollmentId, input.scanId);
      if (!result.ok) return fail(result.message, 400);
      return ok({ completed: true, identity: result.identity });
    }
    // cancel
    const result = await cancelEnrollment(auth.user, input.enrollmentId);
    if (!result.ok) return fail(result.message, 400);
    return ok({ canceled: true });
  } catch (e) {
    if (e instanceof FriendlyApiError) return fail(e.message, 400);
    return handleApiError(e);
  }
}
