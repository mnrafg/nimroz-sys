import { z } from "zod";
import { ok, fail, requireUser, readJson, handleApiError, FriendlyApiError } from "@/lib/api";
import {
  resolveAdmsSettings,
  readConnectionProfile,
  saveAdmsSettings,
  invalidateAdmsSettingsCache,
  tokenTransportAllowed,
} from "@/lib/biometric/terminal-adms-server";
import { admsApiHealth } from "@/lib/biometric/terminal-adms-api";
import { parseAdmsAddress } from "@/lib/biometric/terminal-address";
import { resetAdmsFeed } from "@/lib/biometric/terminal-adms-feed";

// ============================================================
// GET/PUT /api/biometric/terminal/adms-server
// GET ...?check=1  → bounded connection test
//
// Environment-managed keys are reported read-only. Saving refreshes
// affected monitors immediately (feed baseline reset) without an
// application restart. Changing the address here never claims to
// change Windows network settings, the terminal's Ethernet address,
// its ADMS menu, router configuration or provider firewall rules.
// ============================================================

const saveSchema = z.object({
  protocol: z.enum(["http", "https"]),
  host: z.string().max(253),
  port: z.number().int().min(1).max(65535),
  readEnabled: z.boolean(),
  // application-facing API override — a DIFFERENT network path than the
  // device-facing destination; empty host clears the override
  apiProtocol: z.enum(["http", "https"]).nullish(),
  apiHost: z.string().max(253).nullish(),
  apiPort: z.number().int().min(1).max(65535).nullish(),
});

function publicView(resolved: Awaited<ReturnType<typeof resolveAdmsSettings>>) {
  return {
    settings: resolved.settings,
    serverUrl: resolved.serverUrl,
    apiUrl: resolved.apiUrl,
    hasApiToken: !!resolved.apiToken,
    tokenTransportAllowed: tokenTransportAllowed(resolved.apiUrl),
    envManaged: resolved.envManaged,
    // NOTE: resolved.connectionDir (a server filesystem path) is
    // deliberately NOT exposed here — ordinary administrator summaries
    // never carry internal filesystem paths.
    configError: resolved.configError,
  };
}

export async function GET(request: Request) {
  const auth = await requireUser(["ADMIN"]);
  if (auth.response) return auth.response;
  try {
    const { searchParams } = new URL(request.url);
    const resolved = await resolveAdmsSettings();
    if (searchParams.get("check") === "1") {
      if (resolved.configError) {
        return ok({
          check: {
            reachable: false,
            message:
              resolved.configError === "DB_UNAVAILABLE"
                ? "خواندن تنظیمات از حافظه داده ناموفق بود؛ لطفاً دوباره تلاش کنید."
                : "مقدار ذخیره‌شده تنظیمات قابل خواندن نیست؛ لطفاً تنظیمات را دوباره ذخیره کنید.",
          },
          ...publicView(resolved),
        });
      }
      if (!resolved.apiUrl) {
        return ok({ check: { reachable: false, message: "آدرس سرور ADMS تنظیم نشده است." }, ...publicView(resolved) });
      }
      if (resolved.apiToken && !tokenTransportAllowed(resolved.apiUrl)) {
        return ok({
          check: {
            reachable: false,
            message: "ارسال توکن احراز هویت روی HTTP ساده مجاز نیست؛ از HTTPS یا تونل محلی استفاده کنید.",
          },
          ...publicView(resolved),
        });
      }
      const health = await admsApiHealth({
        url: resolved.apiUrl,
        caPem: readConnectionProfile(resolved.apiUrl).caPem,
        bearerToken: tokenTransportAllowed(resolved.apiUrl) ? resolved.apiToken : null,
        timeoutMs: 6000,
      });
      return ok({
        check: health,
        note: health.reachable
          ? "سلامت API سرور تأیید شد؛ این به معنی آنلاین بودن دستگاه نیست."
          : null,
        ...publicView(resolved),
      });
    }
    return ok(publicView(resolved));
  } catch (e) {
    return handleApiError(e);
  }
}

export async function PUT(request: Request) {
  const auth = await requireUser(["ADMIN"]);
  if (auth.response) return auth.response;
  const body = await readJson(request, saveSchema);
  if (body.response) return body.response;
  try {
    const resolved = await resolveAdmsSettings();
    const editable = resolved.envManaged;
    const next = {
      protocol: editable.serverUrl ? resolved.settings.protocol : body.data.protocol,
      host: editable.serverUrl ? resolved.settings.host : body.data.host.toLowerCase(),
      port: editable.serverUrl ? resolved.settings.port : body.data.port,
      readEnabled: editable.readEnabled ? resolved.settings.readEnabled : body.data.readEnabled,
      // API override is editable whenever the environment does not own it
      apiProtocol: editable.apiUrl
        ? resolved.settings.apiProtocol ?? null
        : (body.data.apiProtocol ?? "http"),
      apiHost: editable.apiUrl
        ? resolved.settings.apiHost ?? null
        : ((body.data.apiHost ?? "").trim().toLowerCase() || null),
      apiPort: editable.apiUrl
        ? resolved.settings.apiPort ?? null
        : (body.data.apiHost?.trim() ? body.data.apiPort ?? 8082 : null),
    };
    if (!editable.serverUrl && next.host && !parseAdmsAddress(`${next.protocol}://${next.host}:${next.port}`, next.port, next.protocol)) {
      return fail("آدرس سرور ADMS نامعتبر است.");
    }
    if (!editable.serverUrl && !next.host) {
      return fail("آدرس (IP یا نام میزبان) سرور ADMS لازم است.");
    }
    if (next.readEnabled && !next.host) return fail("قبل از فعال‌سازی خواندن اسکن‌ها، آدرس سرور را ثبت کنید.");
    // application-facing API override must parse when provided
    if (next.apiHost) {
      const apiParsed = parseAdmsAddress(`${next.apiProtocol ?? "http"}://${next.apiHost}:${next.apiPort ?? 8082}`, next.apiPort ?? 8082, next.apiProtocol ?? "http");
      if (!apiParsed) return fail("آدرس API خصوصی نامعتبر است.");
    }
    const nextApiUrl = next.apiHost
      ? `${next.apiProtocol ?? "http"}://${next.apiHost}:${next.apiPort ?? 8082}`
      : `${next.protocol}://${next.host}:${next.port}`;
    if (resolved.apiToken && !tokenTransportAllowed(nextApiUrl)) {
      return fail("ذخیره توکن با HTTP ساده مجاز نیست؛ از HTTPS استفاده کنید یا توکن را از متغیر محیطی بخوانید.");
    }
    await saveAdmsSettings(next, auth.user.id);
    resetAdmsFeed(); // new baseline for every device — history never replayed
    invalidateAdmsSettingsCache();
    const updated = await resolveAdmsSettings();
    return ok(publicView(updated));
  } catch (e) {
    if (e instanceof FriendlyApiError) return fail(e.message, 400);
    return handleApiError(e);
  }
}
