import { z } from "zod";
import { DEFAULT_ADMS_PORTS } from "./terminal-address";

// ============================================================
// ADMS server setup-wizard contract (app-side backend).
//
// POST /api/biometric/terminal/adms-server/setup — one action per call:
//   fingerprint → inspect → plan → install (NDJSON stream) → activate
//
// SECURITY RULES (enforced across the whole module family):
//   • The SSH password is TRANSIENT — it is parsed, used for the SSH
//     connection and then dropped. It is never logged, never persisted,
//     never placed in audit entries, URLs, query caches or error text.
//   • The SSH host key is pinned by fingerprint; authentication happens
//     ONLY after the key matches the fingerprint captured earlier.
//   • TLS verification of the installed ADMS API is never disabled
//     (rejectUnauthorized stays true; trust is pinned via `ca`).
//   • Facts are OBSERVED FACTS; POSSIBLE CAUSES are always labelled as
//     such and never conflated (a route lookup does not prove
//     end-to-end connectivity).
// ============================================================

// ---------- deployed namespace (single source of truth) ----------

export const ADMS_SERVICE_NAME = "aogc-bicms-adms.service";
export const ADMS_ACCOUNT = "bicms-adms";
export const ADMS_GROUP = "bicms-adms";
export const ADMS_OPT_DIR = "/opt/aogc-bicms-adms";
export const ADMS_RELEASES_DIR = `${ADMS_OPT_DIR}/releases`;
export const ADMS_ETC_DIR = "/etc/aogc-bicms-adms";
export const ADMS_VAR_DIR = "/var/lib/aogc-bicms-adms";
export const ADMS_DB_FILE = `${ADMS_VAR_DIR}/bicms-adms.db`;
export const ADMS_PYTHON_ENTRY = "bicms_adms.py";
export const ADMS_BUNDLE_REMOTE_PATH = "/tmp/aogc-bicms-adms-bundle.tgz";

/** Ports probed/managed by the wizard. Order: ssh, device, internal, https. */
export const ADMS_SETUP_PORTS = [
  DEFAULT_ADMS_PORTS.ssh,
  DEFAULT_ADMS_PORTS.deviceListener,
  DEFAULT_ADMS_PORTS.internalApi,
  DEFAULT_ADMS_PORTS.httpsApi,
] as const;

/** Short-lived signed plan lifetime (~10 minutes). */
export const ADMS_PLAN_TTL_MS = 10 * 60 * 1000;

// ---------- shared field validators ----------

const HOST_RE = /^[a-zA-Z0-9._-]{1,253}$/;
const SERIAL_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;

export const hostField = z
  .string()
  .regex(HOST_RE, "آدرس میزبان نامعتبر است.");
export const serialField = z
  .string()
  .regex(SERIAL_RE, "سریال دستگاه نامعتبر است.");
export const sshPortField = z
  .number()
  .int()
  .min(1)
  .max(65535)
  .default(DEFAULT_ADMS_PORTS.ssh);
export const portField = z
  .number()
  .int()
  .min(1)
  .max(65535);
export const fingerprintField = z
  .string()
  .regex(FINGERPRINT_RE, "اثر انگشت کلید SSH نامعتبر است (باید SHA256:… باشد).");
export const passwordField = z
  .string()
  .min(1)
  .max(512)
  // Transient-only field: never serialized into errors by zod defaults.
  .meta({ description: "SSH password (transient, never persisted)" });

// ---------- request bodies (one action per call) ----------

export const fingerprintBodySchema = z.object({
  action: z.literal("fingerprint"),
  host: hostField,
  sshPort: sshPortField,
});

export const inspectBodySchema = z.object({
  action: z.literal("inspect"),
  host: hostField,
  sshPort: sshPortField,
  username: z.string().min(1).max(64),
  password: passwordField,
  deviceSerial: serialField,
});

export const portsSchema = z
  .object({
    ssh: portField.optional(),
    deviceListener: portField.optional(),
    internalApi: portField.optional(),
    httpsApi: portField.optional(),
  })
  .refine(
    (p) =>
      !p.ssh ||
      !p.deviceListener ||
      !p.internalApi ||
      !p.httpsApi ||
      new Set([p.ssh, p.deviceListener, p.internalApi, p.httpsApi]).size === 4,
    { message: "پورت‌های انتخابی نباید با هم یکسان باشند." }
  );

export const planBodySchema = z.object({
  action: z.literal("plan"),
  host: hostField,
  sshPort: sshPortField,
  username: z.string().min(1).max(64),
  deviceSerial: serialField,
  ports: portsSchema.optional().default({}),
  password: passwordField,
  mode: z.enum(["install", "resume", "connect", "upgrade"]),
  sshFingerprint: fingerprintField,
});

export const installBodySchema = z.object({
  action: z.literal("install"),
  planToken: z.string().min(20).max(400),
  password: passwordField,
});

export const activateBodySchema = z.object({
  action: z.literal("activate"),
  apiUrl: z
    .string()
    .regex(/^https:\/\/[a-zA-Z0-9._:-]+(:\d+)?\/?$/, "آدرس API باید HTTPS باشد."),
  caPem: z.string().max(12_000).optional(),
});

export const setupBodySchema = z.discriminatedUnion("action", [
  fingerprintBodySchema,
  inspectBodySchema,
  planBodySchema,
  installBodySchema,
  activateBodySchema,
]);

export type FingerprintBody = z.infer<typeof fingerprintBodySchema>;
export type InspectBody = z.infer<typeof inspectBodySchema>;
export type PlanBody = z.infer<typeof planBodySchema>;
export type InstallBody = z.infer<typeof installBodySchema>;
export type ActivateBody = z.infer<typeof activateBodySchema>;
export type SetupBody = z.infer<typeof setupBodySchema>;

// ---------- plan shapes ----------

export type SetupMode = "install" | "resume" | "connect" | "upgrade";

export interface SetupPlanPorts {
  ssh: number;
  deviceListener: number;
  internalApi: number;
  httpsApi: number;
}

/** The signed payload — canonical JSON over exactly these fields. */
export interface SetupPlan {
  planId: string;
  adminId: number;
  host: string;
  ports: SetupPlanPorts;
  deviceSerial: string;
  sshFingerprint: string;
  arch: string;
  artifactChecksum: string;
  mode: SetupMode;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

// ---------- inspection shapes ----------

export interface InspectFacts {
  os: string | null;
  arch: string | null;
  archSupported: boolean;
  systemdPresent: boolean;
  python3: { present: boolean; version: string | null };
  python3Venv: { available: boolean };
  openssl: { present: boolean; version: string | null };
  service: { installed: boolean; active: boolean };
  directories: {
    opt: { exists: boolean; owner: string | null; group: string | null };
    etc: { exists: boolean; owner: string | null; group: string | null };
    var: { exists: boolean; owner: string | null; group: string | null };
  };
  ufw: { available: boolean; status: string | null };
}

export type ListenerOccupancy = { occupied: boolean; byWhom: string | null };

export type ListenerMap = {
  ssh: ListenerOccupancy;
  deviceListener: ListenerOccupancy;
  internalApi: ListenerOccupancy;
  httpsApi: ListenerOccupancy;
};

export interface DeviceObservations {
  seenRequests: boolean;
  lastSeen: string | null;
}

export interface PlanProposal {
  mode: SetupMode;
  reason: string;
}

export interface InspectOutcome {
  facts: InspectFacts;
  listeners: ListenerMap;
  deviceObservations: DeviceObservations;
  findings: string[];
  planProposal: PlanProposal;
}

// ---------- NDJSON event shapes (install stream) ----------

export type SetupStage =
  | "connecting"
  | "checking"
  | "uploading"
  | "installing"
  | "verifying";

export interface InstallResult {
  apiUrl: string;
  caPem: string;
  tokenSaved: boolean;
  listenersOk: boolean;
  apiOk: boolean;
}

export type SetupEvent =
  | { type: "stage"; stage: SetupStage; message: string }
  | { type: "progress"; percent: number; bytesSent: number; bytesTotal: number }
  | { type: "log"; message: string }
  | { type: "need-inspect"; message: string }
  | { type: "done"; result: InstallResult }
  | { type: "error"; message: string; uncertain?: boolean };

// ---------- activation response ----------

export interface ActivateOutcome {
  action: "activate";
  activated: boolean;
  settings: {
    protocol: string;
    host: string;
    port: number;
    readEnabled: boolean;
  };
}
