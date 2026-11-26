import "server-only";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { getAuthSecret } from "@/lib/secret";
import { ADMS_PLAN_TTL_MS, type SetupMode, type SetupPlan, type SetupPlanPorts } from "./adms-setup-contract";

// ============================================================
// Short-lived SIGNED setup plans for the ADMS install wizard.
//
// Flow: the admin inspects the server (fingerprint action), then the
// plan action issues a plan bound to { admin, host, ports, device
// serial, SSH fingerprint, arch, artifact checksum, mode } and signed
// with HMAC-SHA256 over canonical JSON using the application auth
// secret (getAuthSecret). The install action must present the token
// back within ~10 minutes; tokens are SINGLE-USE with replay
// protection in two layers:
//   1. in-memory Map (per-process, immediate)
//   2. TerminalReceipt table (durable, survives restarts)
//
// The token never contains the SSH password (the password is only
// ever sent transiently with the install call itself).
// ============================================================

export type PlanToken = string;

interface PlanStoreEntry {
  plan: SetupPlan;
  signature: string;
  token: PlanToken;
  used: boolean;
}

const store = new Map<string, PlanStoreEntry>();
let lastPrune = 0;

function pruneExpired(nowMs: number): void {
  if (nowMs - lastPrune < 60_000) return;
  lastPrune = nowMs;
  for (const [id, entry] of store) {
    if (entry.plan.expiresAt < nowMs) store.delete(id);
  }
}

/** Canonical JSON: recursively sorted object keys, arrays preserved. */
export function canonicalPlanJson(plan: SetupPlan): string {
  const stringify = (value: unknown): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stringify).join(",")}]`;
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${stringify((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  };
  return stringify(plan);
}

/** HMAC-SHA256 signature (hex) over the canonical plan JSON. */
export function signPlan(plan: SetupPlan): string {
  return createHmac("sha256", Buffer.from(getAuthSecret(), "utf8"))
    .update(canonicalPlanJson(plan), "utf8")
    .digest("hex");
}

export function verifyPlanSignature(plan: SetupPlan, signature: string): boolean {
  const expected = signPlan(plan);
  const a = Buffer.from(signature, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface CreatePlanArgs {
  adminId: number;
  host: string;
  ports: SetupPlanPorts;
  deviceSerial: string;
  sshFingerprint: string;
  arch: string;
  artifactChecksum: string;
  mode: SetupMode;
  nowMs?: number;
}

export interface CreatedPlan {
  plan: SetupPlan;
  planToken: PlanToken;
}

/** Issue a fresh signed plan (~10 minute validity). */
export function createSetupPlan(args: CreatePlanArgs): CreatedPlan {
  const now = args.nowMs ?? Date.now();
  const plan: SetupPlan = {
    planId: randomUUID(),
    adminId: args.adminId,
    host: args.host,
    ports: { ...args.ports },
    deviceSerial: args.deviceSerial,
    sshFingerprint: args.sshFingerprint,
    arch: args.arch,
    artifactChecksum: args.artifactChecksum,
    mode: args.mode,
    issuedAt: now,
    expiresAt: now + ADMS_PLAN_TTL_MS,
    nonce: randomBytes(16).toString("hex"),
  };
  const signature = signPlan(plan);
  const token: PlanToken = `${plan.planId}.${signature}`;
  pruneExpired(now);
  store.set(plan.planId, { plan, signature, token, used: false });
  return { plan, planToken: token };
}

export interface VerifyPlanOptions {
  nowMs?: number;
  adminId?: number;
  host?: string;
  deviceSerial?: string;
  mode?: SetupMode;
  sshFingerprint?: string;
  artifactChecksum?: string;
  /** mark the token consumed (single-use) when verification succeeds */
  consume?: boolean;
}

export type PlanVerification =
  | { ok: true; plan: SetupPlan }
  | { ok: false; reason: string };

/** Durable replay protection (TerminalReceipt), best-effort + fail-open. */
async function durableReplayCheck(token: PlanToken, expiresAt: number, consume: boolean): Promise<boolean | null> {
  try {
    const { db } = await import("@/lib/db");
    if (!consume) {
      const existing = await db.terminalReceipt.findUnique({
        where: { id_deviceKey: { id: token, deviceKey: "adms-setup-plan" } },
      });
      return !existing;
    }
    try {
      await db.terminalReceipt.create({
        data: { id: token, deviceKey: "adms-setup-plan", expiresAt: new Date(expiresAt) },
      });
      return true;
    } catch (e) {
      const raw = String((e as Error)?.message ?? "");
      if (/unique|constraint/i.test(raw)) return false; // replayed token
      // DB hiccup — in-memory protection remains active; fail open.
      console.warn("[adms-setup-plan] terminal receipt write skipped");
      return null;
    }
  } catch {
    // DB module unavailable (e.g. unit smoke test) — memory layer only.
    return null;
  }
}

/**
 * Verify a plan token: signature → expiry → field bindings → replay.
 * When `consume` is set, a successful verification burns the token
 * (single-use) in both the memory store and TerminalReceipt.
 */
export async function verifyPlanToken(token: string, options: VerifyPlanOptions = {}): Promise<PlanVerification> {
  const now = options.nowMs ?? Date.now();
  pruneExpired(now);

  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) {
    return { ok: false, reason: "توکن طرح نصب نامعتبر است." };
  }
  const planId = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const entry = store.get(planId);
  if (!entry) {
    return { ok: false, reason: "توکن طرح نصب شناخته‌شده نیست یا منقضی شده است؛ مرحله طرح را دوباره اجرا کنید." };
  }
  if (entry.token !== token || !verifyPlanSignature(entry.plan, signature)) {
    return { ok: false, reason: "امضای توکن طرح نصب تأیید نشد." };
  }
  if (entry.plan.expiresAt < now) {
    store.delete(planId);
    return { ok: false, reason: "توکن طرح نصب منقضی شده است؛ مرحله طرح را دوباره اجرا کنید." };
  }
  if (options.adminId !== undefined && entry.plan.adminId !== options.adminId) {
    return { ok: false, reason: "این توکن برای کاربر دیگری صادر شده است." };
  }
  if (options.host !== undefined && entry.plan.host !== options.host) {
    return { ok: false, reason: "آدرس میزبان با طرح صادرشده مطابقت ندارد." };
  }
  if (options.deviceSerial !== undefined && entry.plan.deviceSerial !== options.deviceSerial) {
    return { ok: false, reason: "سریال دستگاه با طرح صادرشده مطابقت ندارد." };
  }
  if (options.mode !== undefined && entry.plan.mode !== options.mode) {
    return { ok: false, reason: "نوع عملیات با طرح صادرشده مطابقت ندارد." };
  }
  if (options.sshFingerprint !== undefined && entry.plan.sshFingerprint !== options.sshFingerprint) {
    return { ok: false, reason: "اثر انگشت کلید SSH با طرح صادرشده مطابقت ندارد." };
  }
  if (options.artifactChecksum !== undefined && entry.plan.artifactChecksum !== options.artifactChecksum) {
    return { ok: false, reason: "بسته‌ی نصبی از زمان صدور طرح تغییر کرده است؛ طرح جدید صادر کنید." };
  }
  if (entry.used) {
    return { ok: false, reason: "این توکن یک‌بار مصرف است و قبلاً استفاده شده است." };
  }

  const free = await durableReplayCheck(token, entry.plan.expiresAt, options.consume === true);
  if (free === false) {
    return { ok: false, reason: "این توکن یک‌بار مصرف است و قبلاً استفاده شده است." };
  }

  if (options.consume === true) {
    entry.used = true;
    store.delete(planId);
  }
  return { ok: true, plan: entry.plan };
}
