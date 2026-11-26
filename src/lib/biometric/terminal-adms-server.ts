import "server-only";
import { db } from "@/lib/db";
import { parseAdmsAddress, admsOrigin, isLoopbackHost, type AdmsProtocol } from "./terminal-address";
import { decryptTerminalSecret, encryptTerminalSecret } from "./terminal-security";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { readAdmsDeploymentConnection, writeAdmsDeploymentConnection } from "./adms-deployment-config";

// ============================================================
// Shared ADMS server settings (admin-managed) + environment
// overrides. Stored in SystemSetting under one JSON key so the
// change is additive and restart-free (monitors re-read on demand).
//
// Two different endpoints are kept apart:
//   • device-facing destination (what the terminal's ADMS menu shows)
//   • application-facing authenticated API (what THIS app reads)
//
// Environment overrides (win over DB, shown read-only):
//   TERMINAL_ADMS_SERVER_URL          device-facing origin
//   TERMINAL_ADMS_SERVER_ENABLED      device-facing reading toggle
//   TERMINAL_ADMS_API_URL             application-facing API origin
//   TERMINAL_ADMS_API_TOKEN_FILE      file containing the bearer token
//   TERMINAL_ADMS_API_TOKEN           literal bearer token (last resort)
//   TERMINAL_ADMS_CONNECTION_DIR      encrypted connection profiles dir
// ============================================================

const SETTING_KEY = "terminal.admsServer";

export interface TerminalAdmsSettings {
  protocol: AdmsProtocol;
  host: string;
  port: number;
  /** Application reads fresh scans from the ADMS API when true. */
  readEnabled: boolean;
  /**
   * Application-facing API override (optional). When unset the API
   * address falls back to the device-facing origin — an explicit
   * override exists because the address the TERMINAL can reach and
   * the address the APP backend can reach are different networks and
   * often different hosts/ports.
   */
  apiProtocol?: AdmsProtocol | null;
  apiHost?: string | null;
  apiPort?: number | null;
}

const DEFAULTS: TerminalAdmsSettings = {
  protocol: "http",
  host: "",
  port: 8080,
  readEnabled: false,
};

export interface ResolvedAdmsSettings {
  settings: TerminalAdmsSettings;
  /** normalized device-facing origin (or null when unset) */
  serverUrl: string | null;
  /** normalized application-facing API origin (or null when unset) */
  apiUrl: string | null;
  /** resolved bearer token, or null */
  apiToken: string | null;
  /** which keys are environment-managed (read-only in the UI) */
  envManaged: { serverUrl: boolean; readEnabled: boolean; apiUrl: boolean; apiToken: boolean };
  connectionDir: string;
  /**
   * Sanitized configuration-read problem, or null. A DB failure is
   * surfaced to the admin UI ("configuration unavailable") instead of
   * silently presenting factory defaults as if nothing happened.
   */
  configError: "DB_UNAVAILABLE" | "STORED_VALUE_CORRUPT" | "DEPLOYMENT_CONFIG_UNAVAILABLE" | null;
}

function readEnv(): Partial<{
  serverUrl: string;
  apiUrl: string;
  token: string;
  readEnabled: boolean;
}> {
  const out: Partial<{ serverUrl: string; apiUrl: string; token: string; readEnabled: boolean }> = {};
  const rawServer = process.env.TERMINAL_ADMS_SERVER_URL?.trim();
  if (rawServer) out.serverUrl = rawServer;
  const rawApi = process.env.TERMINAL_ADMS_API_URL?.trim();
  if (rawApi) out.apiUrl = rawApi;
  const tokenFile = process.env.TERMINAL_ADMS_API_TOKEN_FILE?.trim();
  if (tokenFile && existsSync(tokenFile)) {
    try {
      const t = readFileSync(tokenFile, "utf8").trim();
      if (t) out.token = t;
    } catch {
      // unreadable token file — treated as absent
    }
  }
  const token = process.env.TERMINAL_ADMS_API_TOKEN?.trim();
  if (token && !out.token) out.token = token;
  const enabled = process.env.TERMINAL_ADMS_SERVER_ENABLED?.trim();
  if (enabled === "1" || enabled === "true") out.readEnabled = true;
  if (enabled === "0" || enabled === "false") out.readEnabled = false;
  return out;
}

export function admsConnectionDir(): string {
  return process.env.TERMINAL_ADMS_CONNECTION_DIR?.trim() || join(process.cwd(), ".local", "adms", "connections");
}

/** Read the persisted encrypted ADMS API token for a given API origin. */
export function readConnectionToken(apiUrl: string): string | null {
  return readConnectionProfile(apiUrl).token;
}

/**
 * Persist an encrypted ADMS connection profile (token AES-256-GCM at
 * rest + pinned trust material). TLS verification is NEVER disabled.
 */
export function writeConnectionProfile(args: { apiUrl: string; token: string; caPem: string; deviceUrl?: string }): void {
  const dir = admsConnectionDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${Buffer.from(args.apiUrl).toString("base64url")}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        apiUrl: args.apiUrl,
        deviceUrl: args.deviceUrl,
        caPem: args.caPem,
        tokenEnc: encryptTerminalSecret(args.token),
        createdAt: new Date().toISOString(),
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
}

export function readConnectionProfile(apiUrl: string): { token: string | null; caPem: string | null; deviceUrl?: string | null } {
  const dir = admsConnectionDir();
  const file = join(dir, `${Buffer.from(apiUrl).toString("base64url")}.json`);
  const deployment = readAdmsDeploymentConnection();
  let profile: { token: string | null; caPem: string | null; deviceUrl?: string | null } =
    deployment && new URL(deployment.apiUrl).origin === new URL(apiUrl).origin
      ? { token: deployment.token, caPem: deployment.caPem, deviceUrl: deployment.serverUrl }
      : { token: null, caPem: null };
  try {
    if (!profile.token && existsSync(file)) {
      const json = JSON.parse(readFileSync(file, "utf8")) as { tokenEnc?: string; caPem?: string; deviceUrl?: string };
      profile = {
        token: json.tokenEnc ? decryptTerminalSecret(json.tokenEnc) : null,
        caPem: json.caPem ?? null,
        deviceUrl: json.deviceUrl ?? null,
      };
    }
  } catch {
    // An unreadable encrypted profile cannot supply credentials or trust.
  }
  // Server-managed trust file: no certificate entry/repeated setup in the UI.
  const caFile = process.env.TERMINAL_ADMS_API_CA_FILE?.trim();
  if (caFile) profile.caPem = readFileSync(caFile, "utf8");
  return profile;
}

let cache: { data: TerminalAdmsSettings; at: number } | null = null;
const CACHE_MS = 10_000;

export function invalidateAdmsSettingsCache(): void {
  cache = null;
}

/** Resolve persisted + environment-overridden settings. */
export async function resolveAdmsSettings(): Promise<ResolvedAdmsSettings> {
  // Dev-only convenience: make sure the loopback ADMS runtime is up so
  // this resolver and the connection check report the REAL service
  // state. Idempotent, fire-and-forget, never runs in production.
  try {
    const { ensureDevAdmsRuntime } = await import("@/instrumentation-adms");
    ensureDevAdmsRuntime();
  } catch {
    // instrumentation module unavailable — settings resolution continues
  }

  let stored: TerminalAdmsSettings = { ...DEFAULTS };
  let configError: ResolvedAdmsSettings["configError"] = null;
  try {
    if (cache && Date.now() - cache.at < CACHE_MS) stored = { ...cache.data };
    else {
      const row = await db.systemSetting.findUnique({ where: { key: SETTING_KEY } });
      if (row) {
        try {
          const parsed = JSON.parse(row.value) as Partial<TerminalAdmsSettings>;
          if (parsed.protocol === "http" || parsed.protocol === "https") stored.protocol = parsed.protocol;
          if (typeof parsed.host === "string") stored.host = parsed.host;
          if (Number.isInteger(parsed.port) && parsed.port! >= 1 && parsed.port! <= 65535) stored.port = parsed.port!;
          stored.readEnabled = parsed.readEnabled === true;
          // explicit application-facing API override (additive, optional)
          if (parsed.apiProtocol === "http" || parsed.apiProtocol === "https") stored.apiProtocol = parsed.apiProtocol;
          if (typeof parsed.apiHost === "string") stored.apiHost = parsed.apiHost;
          if (Number.isInteger(parsed.apiPort) && parsed.apiPort! >= 1 && parsed.apiPort! <= 65535) stored.apiPort = parsed.apiPort!;
        } catch (parseError) {
          // corrupted stored JSON — do NOT masquerade defaults as truth
          console.error("[terminal-adms] stored settings value is corrupt", parseError);
          configError = "STORED_VALUE_CORRUPT";
        }
      }
      cache = { data: { ...stored }, at: Date.now() };
    }
  } catch (dbError) {
    // settings storage unreachable — reported instead of silently cleared
    console.error("[terminal-adms] settings read failed", dbError);
    configError = "DB_UNAVAILABLE";
  }

  // The portable backend connection takes precedence over per-database
  // defaults. A fresh database or a new user therefore needs no ADMS setup.
  try {
    const deployment = readAdmsDeploymentConnection();
    if (deployment) {
      const deviceAddress = deployment.serverUrl ? new URL(deployment.serverUrl) : null;
      const device = deviceAddress
        ? parseAdmsAddress(deployment.serverUrl!, deviceAddress.protocol === "https:" ? 443 : 80)
        : null;
      const apiAddress = new URL(deployment.apiUrl);
      const api = parseAdmsAddress(deployment.apiUrl, apiAddress.protocol === "https:" ? 443 : 80)!;
      stored = {
        ...stored,
        protocol: device?.protocol ?? stored.protocol,
        host: device?.host ?? "",
        port: device?.port ?? stored.port,
        readEnabled: deployment.readEnabled,
        apiProtocol: api.protocol,
        apiHost: api.host,
        apiPort: api.port,
      };
    }
  } catch {
    configError = "DEPLOYMENT_CONFIG_UNAVAILABLE";
  }

  const env = readEnv();
  const envManaged = {
    serverUrl: !!env.serverUrl,
    readEnabled: env.readEnabled !== undefined,
    apiUrl: !!env.apiUrl,
    apiToken: !!env.token,
  };

  let settings = { ...stored };
  let serverUrl: string | null = null;
  let apiUrl: string | null = null;

  if (env.serverUrl) {
    const parsed = parseAdmsAddress(env.serverUrl, 8080);
    if (parsed) {
      serverUrl = admsOrigin(parsed);
      settings = { ...settings, protocol: parsed.protocol, host: parsed.host, port: parsed.port };
    }
  } else if (settings.host) {
    serverUrl = admsOrigin({ protocol: settings.protocol, host: settings.host, port: settings.port });
  }

  if (env.apiUrl) {
    const parsed = parseAdmsAddress(env.apiUrl, 8082);
    if (parsed) apiUrl = admsOrigin(parsed);
  } else if (settings.apiHost) {
    // admin-configured application-facing API address (UI field)
    const parsed = parseAdmsAddress(
      `${settings.apiProtocol ?? "http"}://${settings.apiHost}:${settings.apiPort ?? 8082}`,
      settings.apiPort ?? 8082,
      settings.apiProtocol ?? "http"
    );
    if (parsed) apiUrl = admsOrigin(parsed);
  }
  if (!apiUrl && serverUrl) apiUrl = serverUrl; // same origin by default

  if (env.readEnabled !== undefined) settings.readEnabled = env.readEnabled;

  let apiToken: string | null = env.token ?? null;
  if (!apiToken && apiUrl && configError !== "DEPLOYMENT_CONFIG_UNAVAILABLE") {
    try { apiToken = readConnectionToken(apiUrl); }
    catch { configError = "DEPLOYMENT_CONFIG_UNAVAILABLE"; }
  }

  return { settings, serverUrl, apiUrl, apiToken, envManaged, connectionDir: admsConnectionDir(), configError };
}

/**
 * Security rule: a bearer credential is NEVER transmitted over public
 * plaintext HTTP. Loopback/plain-protected deployments are allowed.
 */
export function tokenTransportAllowed(apiUrl: string | null): boolean {
  if (!apiUrl) return false;
  const parsed = parseAdmsAddress(apiUrl);
  if (!parsed) return false;
  return parsed.protocol === "https" || isLoopbackHost(parsed.host);
}

/** Save settings from the admin UI (no-op when every key is env-managed). */
export async function saveAdmsSettings(next: TerminalAdmsSettings, updatedBy: number): Promise<void> {
  const serverUrl = next.host ? admsOrigin(next) : null;
  const api = next.apiHost
    ? parseAdmsAddress(`${next.apiProtocol ?? "http"}://${next.apiHost}:${next.apiPort ?? 8082}`)
    : (serverUrl ? parseAdmsAddress(serverUrl) : null);
  const apiUrl = api ? admsOrigin(api) : null;
  const profile = apiUrl ? readConnectionProfile(apiUrl) : null;
  const token = readEnv().token ?? profile?.token;
  if (next.readEnabled && !token) throw new Error("Save the authenticated ADMS connection before enabling reads.");
  const value = JSON.stringify({
    protocol: next.protocol,
    host: next.host,
    port: next.port,
    readEnabled: next.readEnabled,
    apiProtocol: next.apiProtocol ?? null,
    apiHost: next.apiHost ?? null,
    apiPort: next.apiPort ?? null,
  });
  await db.systemSetting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, value, updatedBy },
    update: { value, updatedBy },
  });
  if (apiUrl && token) {
    writeAdmsDeploymentConnection({ serverUrl, apiUrl, token, caPem: profile?.caPem ?? null, readEnabled: next.readEnabled });
  }
  cache = null;
}
