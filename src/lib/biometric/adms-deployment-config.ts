import "server-only";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Private backend configuration, independent of databases and user sessions. */
export interface AdmsDeploymentConnection {
  serverUrl: string | null;
  apiUrl: string;
  readEnabled: boolean;
  token: string;
  caPem: string | null;
}

interface SavedConnection extends Omit<AdmsDeploymentConnection, "token"> {
  version: 1;
  tokenEnc: string;
}

export class AdmsDeploymentConfigError extends Error {
  constructor() {
    super("The saved ADMS deployment connection or its private key cannot be read.");
    this.name = "AdmsDeploymentConfigError";
  }
}

export function admsDeploymentDirectory(): string {
  return process.env.TERMINAL_ADMS_DEPLOYMENT_DIR?.trim()
    || join(process.cwd(), ".local", "adms", "deployment");
}

function origin(value: unknown): string {
  if (typeof value !== "string") throw new AdmsDeploymentConfigError();
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash) throw new AdmsDeploymentConfigError();
  return url.origin;
}

function metadata(value: Omit<AdmsDeploymentConnection, "token">) {
  const apiUrl = origin(value.apiUrl);
  const api = new URL(apiUrl);
  if (api.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(api.hostname)) {
    throw new AdmsDeploymentConfigError();
  }
  if (value.serverUrl !== null && typeof value.serverUrl !== "string") throw new AdmsDeploymentConfigError();
  if (typeof value.readEnabled !== "boolean" || (value.caPem !== null && typeof value.caPem !== "string")) {
    throw new AdmsDeploymentConfigError();
  }
  if (value.caPem) new X509Certificate(value.caPem);
  return {
    serverUrl: value.serverUrl ? origin(value.serverUrl) : null,
    apiUrl,
    readEnabled: value.readEnabled,
    caPem: value.caPem || null,
  };
}

function key(directory: string, create: boolean): Buffer {
  const managedKey = process.env.TERMINAL_ADMS_DEPLOYMENT_KEY?.trim();
  if (managedKey) {
    if (!/^[a-f\d]{64}$/i.test(managedKey)) throw new AdmsDeploymentConfigError();
    return Buffer.from(managedKey, "hex");
  }
  const file = join(directory, "connection.key");
  if (create && !existsSync(file)) {
    try { writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const value = readFileSync(file, "utf8").trim();
  if (!/^[a-f\d]{64}$/i.test(value)) throw new AdmsDeploymentConfigError();
  return Buffer.from(value, "hex");
}

export function validateAdmsDeploymentConnection(value: AdmsDeploymentConnection): AdmsDeploymentConnection {
  const fields = metadata(value);
  if (typeof value.token !== "string" || !value.token.trim() || Buffer.byteLength(value.token) > 16384) {
    throw new AdmsDeploymentConfigError();
  }
  return { ...fields, token: value.token };
}

/** Absent means unconfigured; a damaged/mismatched profile always fails closed. */
export function readAdmsDeploymentConnection(directory = admsDeploymentDirectory()): AdmsDeploymentConnection | null {
  const file = join(directory, "connection.json");
  if (!existsSync(file)) return null;
  try {
    const text = readFileSync(file, "utf8");
    if (Buffer.byteLength(text) > 1024 * 1024) throw new AdmsDeploymentConfigError();
    const saved = JSON.parse(text) as SavedConnection;
    if (saved.version !== 1 || typeof saved.tokenEnc !== "string") throw new AdmsDeploymentConfigError();
    const fields = metadata(saved);
    const raw = Buffer.from(saved.tokenEnc, "base64");
    if (raw.length < 29) throw new AdmsDeploymentConfigError();
    const decipher = createDecipheriv("aes-256-gcm", key(directory, false), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(JSON.stringify({ version: 1, ...fields })));
    decipher.setAuthTag(raw.subarray(12, 28));
    const token = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    if (!token.trim()) throw new AdmsDeploymentConfigError();
    return { ...fields, token };
  } catch {
    throw new AdmsDeploymentConfigError();
  }
}

/** Save once. The build copies these private files into every server release. */
export function writeAdmsDeploymentConnection(value: AdmsDeploymentConnection, directory = admsDeploymentDirectory()): void {
  const { token, ...fields } = validateAdmsDeploymentConnection(value);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(directory, true), iv);
  cipher.setAAD(Buffer.from(JSON.stringify({ version: 1, ...fields })));
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const saved: SavedConnection = {
    version: 1, ...fields,
    tokenEnc: Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64"),
  };
  const destination = join(directory, "connection.json");
  const temporary = `${destination}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(saved), { mode: 0o600 });
  renameSync(temporary, destination);
}
