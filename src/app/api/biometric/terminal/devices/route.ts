import { z } from "zod";
import { ok, fail, requireUser, readJson, handleApiError, FriendlyApiError } from "@/lib/api";
import { createTerminalDevice, listTerminalDevices, updateTerminalDevice } from "@/lib/biometric/terminal-devices";
import { TERMINAL_TRANSPORTS } from "@/lib/biometric/terminal-rules";

// ============================================================
// GET/POST/PATCH /api/biometric/terminal/devices
// Admin-configured terminal registry. Officers may LIST devices
// within their assigned port (device selection for enrollment and
// live identification) but never create/modify them.
// ============================================================

const deviceInputSchema = z.object({
  name: z.string().min(2).max(80),
  transport: z.enum(["LAN", "ADMS_SERVER"]),
  serial: z.string().min(4).max(64),
  checkpointId: z.number().int().positive(),
  host: z.string().max(253).nullish(),
  port: z.number().int().min(1).max(65535).nullish(),
  timezoneOffsetMinutes: z.number().int().min(-720).max(840).nullish(),
  allowedNetworks: z.string().max(500).nullish(),
  commKey: z.string().max(10).nullish(),
});

export async function GET() {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  try {
    const devices = await listTerminalDevices(auth.user);
    // never expose encrypted secrets; commKey presence only
    return ok({ devices });
  } catch (e) {
    if (e instanceof FriendlyApiError) return fail(e.message, 403);
    return handleApiError(e);
  }
}

export async function POST(request: Request) {
  const auth = await requireUser(["ADMIN"]);
  if (auth.response) return auth.response;
  const body = await readJson(request, deviceInputSchema);
  if (body.response) return body.response;
  try {
    const device = await createTerminalDevice(auth.user, body.data);
    return ok({ device: { ...device, commKeyEnc: undefined } }, 201);
  } catch (e) {
    if (e instanceof FriendlyApiError) return fail(e.message, 400);
    return handleApiError(e);
  }
}

const patchSchema = deviceInputSchema.extend({ id: z.number().int().positive() });

export async function PATCH(request: Request) {
  const auth = await requireUser(["ADMIN"]);
  if (auth.response) return auth.response;
  const body = await readJson(request, patchSchema);
  if (body.response) return body.response;
  try {
    const { id, ...rest } = body.data;
    if (!TERMINAL_TRANSPORTS.includes(rest.transport)) return fail("روش اتصال نامعتبر است.");
    const device = await updateTerminalDevice(auth.user, id, rest);
    return ok({ device: { ...device, commKeyEnc: undefined } });
  } catch (e) {
    if (e instanceof FriendlyApiError) return fail(e.message, 400);
    return handleApiError(e);
  }
}

export async function PUT(request: Request) {
  // enable/disable — application-level only (never the physical terminal)
  const auth = await requireUser(["ADMIN"]);
  if (auth.response) return auth.response;
  const body = await readJson(request, z.object({ id: z.number().int().positive(), isEnabled: z.boolean() }));
  if (body.response) return body.response;
  try {
    const { setTerminalDeviceEnabled } = await import("@/lib/biometric/terminal-devices");
    const device = await setTerminalDeviceEnabled(auth.user, body.data.id, body.data.isEnabled);
    return ok({ device: { ...device, commKeyEnc: undefined } });
  } catch (e) {
    if (e instanceof FriendlyApiError) return fail(e.message, 400);
    return handleApiError(e);
  }
}
