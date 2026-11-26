import "server-only";
import {
  connectSsh,
  execOk,
  getHostKeyFingerprint,
  sftpReadFile,
  sftpUpload,
  shQuote,
  AdmsConnectionLostError,
  AdmsHostKeyError,
  AdmsSshError,
  type SshSession,
} from "./adms-ssh";
import { buildPythonBundle, ADMS_CONFIG_FILENAME, SYSTEMD_UNIT_TEMPLATE, type BundleArtifact } from "./adms-python-package";
import {
  assessNamespace,
  probeDeviceObservations,
  probeNamespace,
  probePortMap,
  probeUfw,
} from "./adms-setup-guard";
import { createSetupPlan, verifyPlanToken } from "./adms-setup-plan";
import { FriendlyApiError } from "@/lib/api";
import { db } from "@/lib/db";
import {
  ADMS_ACCOUNT,
  ADMS_BUNDLE_REMOTE_PATH,
  ADMS_DB_FILE,
  ADMS_ETC_DIR,
  ADMS_OPT_DIR,
  ADMS_RELEASES_DIR,
  ADMS_SERVICE_NAME,
  ADMS_SETUP_PORTS,
  ADMS_VAR_DIR,
  type ActivateBody,
  type ActivateOutcome,
  type FingerprintBody,
  type InspectBody,
  type InspectFacts,
  type InspectOutcome,
  type ListenerMap,
  type PlanBody,
  type SetupPlanPorts,
} from "./adms-setup-contract";
import { admsApiHealth } from "./terminal-adms-api";
import {
  invalidateAdmsSettingsCache,
  readConnectionProfile,
  resolveAdmsSettings,
  saveAdmsSettings,
  writeConnectionProfile,
} from "./terminal-adms-server";
import { admsOrigin, parseAdmsAddress } from "./terminal-address";
import { resetAdmsFeed } from "./terminal-adms-feed";
import type { NdjsonEmitter } from "./adms-setup-response";

// ============================================================
// ADMS setup wizard orchestrators (app-side).
//
// Actions: fingerprint → inspect → plan → install → activate.
//
// OBSERVED FACTS vs POSSIBLE CAUSES: findings strings always mark
// possibilities with «احتمال» and never present a probe result as an
// end-to-end connectivity proof.
//
// SECURITY: the SSH password is transient (never logged/persisted —
// it lives only inside the ssh2 ConnectConfig for the duration of a
// connection); the install pins the SSH host key BEFORE sending the
// password; TLS of the ADMS API is verified with a pinned CA and
// rejectUnauthorized is never disabled anywhere.
//
// The installer NEVER touches: Frappe/ERPNext environments, foreign
// ADMS databases, nginx or other reverse proxies, unrelated firewall
// rules. UFW gets only explicitly approved NEW-port rules and is
// never flushed or disabled.
// ============================================================

const D = {
  connFailed: "اتصال SSH به سرور برقرار نشد؛ آدرس، پورت و دسترسی را بررسی کنید.",
  rootRequired: "این مرحله به دسترسی root روی سرور نیاز دارد؛ با کاربر root وارد شوید.",
  sshFingerprintChanged: "اثر انگشت کلید SSH سرور تغییر کرده است؛ به دلایل امنیتی عملیات قبل از ارسال پاسورد لغو شد.",
  dbBackupImpossible: "پشتیبان‌گیری سازگار از دیتابیس ممکن نشد (sqlite3 و python در دسترس نیستند). نصب متوقف شد؛ دیتابیس موجود دست‌نخورده ماند.",
  depsMissing: "پایتون ۳ یا ماژول venv روی سرور موجود نیست؛ نصب متوقف شد. لطفاً python3 و python3-venv را روی سرور آماده کنید و دوباره بازرسی بگیرید.",
  certToolMissing: "openssl روی سرور موجود نیست؛ تولید گواهی HTTPS ممکن نشد و نصب متوقف شد.",
  tokenToolMissing: "ابزار تولید توکن امن (openssl یا python3) روی سرور موجود نیست؛ نصب متوقف شد.",
  checksumMismatch: "بررسی checksum بسته روی سرور ناموفق بود؛ انتقال فایل خراب بوده است. عملیات متوقف شد.",
  currentDirForeign: `مسیر ${ADMS_OPT_DIR}/current یک لینک معمول به داخل پوشه releases نیست؛ ساختار نامعلوم است. دستی بررسی کنید.`,
  listenersFailed: "بعد از راه‌اندازی، هر سه پورت شنونده (۸۰۸۱/۸۰۸۲/۸۴۴۳) فعال نشدند؛ بازگردانی نسخه قبلی انجام می‌شود.",
} as const;

// ---------------- small helpers ----------------

async function audit(args: { userId: number; action: string; newValues: Record<string, unknown> }): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        userId: args.userId,
        action: args.action,
        recordType: "terminal-adms-server",
        recordId: null,
        newValues: JSON.stringify(args.newValues),
      },
    });
  } catch {
    // audit is best-effort; never fails the wizard over it
  }
}

/** Write a file on the target with a quoted heredoc (no expansion). */
async function writeFileRemote(
  session: SshSession,
  path: string,
  content: string,
  mode = "600"
): Promise<void> {
  const delimiter = "BICMS_EOF_9A3F";
  if (content.includes(delimiter)) throw new AdmsSshError("نوشتن فایل روی سرور ممکن نشد (محتوای نامعتبر).");
  const dir = path.split("/").slice(0, -1).join("/") || "/";
  const cmd =
    `mkdir -p ${shQuote(dir)} && umask 077 && cat > ${shQuote(path)} <<'${delimiter}'\n${content}\n${delimiter}\nchmod ${mode} ${shQuote(path)}`;
  const res = await execOk(session, cmd, { timeoutMs: 10_000 });
  if (!res.ok) throw new AdmsSshError(`نوشتن فایل ${path} روی سرور ناموفق بود.`);
}

async function runDari(session: SshSession, cmd: string, timeoutMs = 20_000, maxBytes = 64 * 1024): Promise<string> {
  const res = await execOk(session, cmd, { timeoutMs, maxBytes });
  if (!res.ok) throw new AdmsSshError("اجرای مرحله نصب روی سرور ناموفق بود.");
  return res.stdout;
}
function normalizeListenerMap(
  map: Map<number, { occupied: boolean; byWhom: string | null }>
): ListenerMap {
  const get = (p: number) => map.get(p) ?? { occupied: false, byWhom: null };
  return {
    ssh: get(22),
    deviceListener: get(8081),
    internalApi: get(8082),
    httpsApi: get(8443),
  };
}

// ---------------- 1) fingerprint ----------------

export interface FingerprintOutcome {
  action: "fingerprint";
  fingerprint: string;
  keyType: string;
}

/** Capture the SSH host key WITHOUT any authentication (no password). */
export async function fingerprintAction(body: FingerprintBody): Promise<FingerprintOutcome> {
  try {
    const hostKey = await getHostKeyFingerprint(body.host, body.sshPort, 8000);
    return { action: "fingerprint", fingerprint: hostKey.fingerprint, keyType: hostKey.keyType };
  } catch (e) {
    if (e instanceof AdmsSshError) throw new FriendlyApiError(e.message);
    throw new FriendlyApiError(D.connFailed);
  }
}

// ---------------- 2) inspect ----------------

export async function inspectAction(body: InspectBody): Promise<InspectOutcome> {
  let session: SshSession;
  try {
    session = await connectSsh({
      host: body.host,
      port: body.sshPort,
      username: body.username,
      password: body.password,
      timeoutMs: 12_000,
    });
  } catch (e) {
    if (e instanceof AdmsSshError) throw new FriendlyApiError(e.message);
    throw new FriendlyApiError(D.connFailed);
  }
  try {
    return await inspectOnSession(session, body);
  } catch (e) {
    if (e instanceof AdmsConnectionLostError) {
      throw new FriendlyApiError("اتصال SSH در میانه بازرسی قطع شد؛ لطفاً دوباره تلاش کنید.");
    }
    if (e instanceof AdmsSshError) throw new FriendlyApiError(e.message);
    throw e;
  } finally {
    session.end();
  }
}

async function inspectOnSession(session: SshSession, body: InspectBody): Promise<InspectOutcome> {
  const [osRes, archRes, systemdRes, pythonRes, venvRes, ensurepipRes, opensslRes, namespace, portMap, ufw, observations] =
    await Promise.all([
        execOk(session, "uname -a 2>/dev/null | head -c 400", { timeoutMs: 6_000 }),
        execOk(session, "uname -m 2>/dev/null", { timeoutMs: 6_000 }),
        execOk(session, "command -v systemctl >/dev/null 2>&1 && echo yes || echo no", { timeoutMs: 6_000 }),
        execOk(session, "python3 --version 2>&1 | head -c 60", { timeoutMs: 6_000 }),
        execOk(session, "python3 -c 'import venv' 2>/dev/null && echo ok || echo missing", { timeoutMs: 8_000 }),
        execOk(session, "python3 -m ensurepip --version >/dev/null 2>&1 && echo ok || echo missing", { timeoutMs: 8_000 }),
        execOk(session, "openssl version 2>/dev/null | head -c 60", { timeoutMs: 6_000 }),
        probeNamespace(session),
        probePortMap(session, ADMS_SETUP_PORTS),
        probeUfw(session),
        probeDeviceObservations(session, body.deviceSerial),
  ]);

  const arch = archRes.ok ? archRes.stdout.trim() || null : null;
  const pythonVersion = pythonRes.ok && /python 3/i.test(pythonRes.stdout) ? pythonRes.stdout.trim() : null;
  const pythonPresent = !!pythonVersion;
  const venvAvailable = venvRes.stdout.trim() === "ok";
  const ensurepipOk = ensurepipRes.stdout.trim() === "ok";
  const opensslVersion = opensslRes.ok ? opensslRes.stdout.trim() || null : null;

  const facts: InspectFacts = {
    os: osRes.ok ? osRes.stdout.trim() || null : null,
    arch,
    archSupported: arch === "x86_64" || arch === "aarch64",
    systemdPresent: systemdRes.ok && systemdRes.stdout.trim() === "yes",
    python3: { present: pythonPresent, version: pythonVersion },
    python3Venv: { available: venvAvailable && ensurepipOk },
    openssl: { present: !!opensslVersion, version: opensslVersion },
    service: { installed: namespace.serviceInstalled, active: namespace.serviceActive },
    directories: { opt: namespace.opt, etc: namespace.etc, var: namespace.var },
    ufw,
  };

  const listeners = normalizeListenerMap(portMap);

  // ---- findings: OBSERVED FACTS first, then clearly-labelled POSSIBLE CAUSES
  const findings: string[] = [];
  findings.push(facts.os ? `سیستم عامل: ${facts.os.slice(0, 120)}` : "سیستم عامل مشخص نشد.");
  findings.push(
    facts.archSupported
      ? `معماری پردازنده (${facts.arch}) پشتیبانی می‌شود.`
      : `معماری پردازنده (${facts.arch ?? "نامعلوم"}) پشتیبانی نمی‌شود؛ انتظار x86_64 یا aarch64 است.`
  );
  findings.push(facts.systemdPresent ? "systemd موجود است." : "systemd پیدا نشد؛ نصب سرویس systemd ممکن نیست.");
  findings.push(
    facts.python3.present
      ? `پایتون ۳ موجود است (${facts.python3.version}).`
      : "پایتون ۳ پیدا نشد؛ بدون آن سرویس نصب نمی‌شود."
  );
  if (facts.python3.present && !facts.python3Venv.available) {
    findings.push("احتمال: ماژول venv در دسترس نیست (بسته python3-venv نصب نیست)؛ محیط مجازی ساخته نمی‌شود.");
  }
  findings.push(
    facts.openssl.present ? `OpenSSL موجود است (${facts.openssl.version}).` : "OpenSSL پیدا نشد؛ تولید گواهی HTTPS ممکن نیست."
  );
  findings.push(
    facts.service.installed
      ? facts.service.active
        ? `سرویس ${ADMS_SERVICE_NAME} نصب و فعال است.`
        : `سرویس ${ADMS_SERVICE_NAME} نصب است اما غیرفعال است.`
      : `سرویس ${ADMS_SERVICE_NAME} هنوز نصب نیست.`
  );
  if (listeners.ssh.occupied) findings.push(`پورت SSH (۲۲) فعال است (${listeners.ssh.byWhom ?? "فرایند ناشناس"}).`);
  for (const [label, port, occ] of [
    ["شنونده دستگاه", 8081, listeners.deviceListener],
    ["API داخلی", 8082, listeners.internalApi],
    ["API امن HTTPS", 8443, listeners.httpsApi],
  ] as const) {
    if (occ.occupied) {
      findings.push(`پورت ${port} (${label}) از قبل اشغال است: ${occ.byWhom ?? "فرایند ناشناس"}.`);
      findings.push("احتمال: این فرایند یک سرویس دیگر روی سرور است و باید قبل از نصب بررسی/جابه‌جا شود.");
    } else {
      findings.push(`پورت ${port} (${label}) آزاد است.`);
    }
  }
  if (ufw.available && ufw.status) {
    findings.push("وضعیت UFW خوانده شد (فقط خواندن؛ هیچ قانونی تغییر نکرد).");
  } else {
    findings.push("UFW در دسترس نیست یا وضعیت آن خوانده نشد.");
  }
  if (observations.seenRequests) {
    findings.push(`دیتابیس سرویس نشانی‌ای از دستگاه ${body.deviceSerial} دارد (آخرین ${observations.lastSeen ?? "نامعلوم"}).`);
  } else if (namespace.dbFileExists) {
    findings.push("دیتابیس سرویس موجود است اما برای این سریال مشاهده‌ای پیدا نشد.");
    findings.push("احتمال: دستگاه هنوز به این سرور متصل نشده، یا سریال متفاوت است، یا ابزار sqlite3 در دسترس نیست.");
  } else {
    findings.push("دیتابیس سرویس هنوز وجود ندارد؛ بنابراین نشانی‌ای از دستگاه ثبت نشده است.");
  }
  findings.push(
    "توجه: این بازرسی فقط از داخل خود سرور خوانده شده و به‌تنهایی اتصال دستگاه تا سرور را اثبات نمی‌کند."
  );

  // ---- plan proposal from the OBSERVED state
  const bundle = buildPythonBundle();
  let mode: InspectOutcome["planProposal"]["mode"] = "install";
  let reason = "سرویس هنوز نصب نیست؛ نصب تازه انجام می‌شود.";
  if (namespace.serviceInstalled && namespace.serviceActive) {
    if (namespace.currentRelease && namespace.currentRelease !== bundle.checksum) {
      mode = "upgrade";
      reason = "سرویس فعال است اما نسخه منتشرشده با بسته فعلی تفاوت دارد؛ به‌روزرسانی پیشنهاد می‌شود.";
    } else {
      mode = "connect";
      reason = "سرویس فعال و هم‌نسخه بسته فعلی است؛ فقط اتصال و تأیید شنونده‌ها انجام می‌شود.";
    }
  } else if (namespace.serviceInstalled) {
    mode = "resume";
    reason = "سرویس نصب است اما غیرفعال است؛ ادامه نصب/فعال‌سازی پیشنهاد می‌شود.";
  }

  return {
    facts,
    listeners,
    deviceObservations: observations,
    findings,
    planProposal: { mode, reason },
  };
}

/** Bounded read-only arch probe used to bind the plan to the target. */
async function probeArchForPlan(body: PlanBody): Promise<string> {
  let session: SshSession;
  try {
    session = await connectSsh({
      host: body.host,
      port: body.sshPort,
      username: body.username,
      password: body.password,
      timeoutMs: 12_000,
    });
  } catch (e) {
    if (e instanceof AdmsSshError) throw new FriendlyApiError(e.message);
    throw new FriendlyApiError(D.connFailed);
  }
  try {
    const res = await execOk(session, "uname -m 2>/dev/null", { timeoutMs: 6_000 });
    const arch = res.ok ? res.stdout.trim() : "";
    if (!arch) throw new FriendlyApiError("معماری پردازنده سرور خوانده نشد؛ مرحله طرح را دوباره اجرا کنید.");
    return arch;
  } finally {
    session.end();
  }
}

// ---------------- 3) plan ----------------

export interface PlanOutcome {
  action: "plan";
  planToken: string;
  plan: { planId: string; mode: string; host: string; ports: SetupPlanPorts; deviceSerial: string; sshFingerprint: string; arch: string; artifactChecksum: string; issuedAt: number; expiresAt: number; nonce: string };
  summary: string;
}

export async function planAction(body: PlanBody, adminId: number): Promise<PlanOutcome> {
  const bundle = buildPythonBundle();
  if (bundle.pythonSource === "placeholder") {
    throw new FriendlyApiError(
      "بسته‌ی زمان اجرای ADMS هنوز آماده نیست (فایل runtime در مخزن موجود نیست)؛ پس از افزودن runtime، مرحله طرح را دوباره اجرا کنید."
    );
  }
  const ports: SetupPlanPorts = {
    ssh: body.ports.ssh ?? body.sshPort,
    deviceListener: body.ports.deviceListener ?? 8081,
    internalApi: body.ports.internalApi ?? 8082,
    httpsApi: body.ports.httpsApi ?? 8443,
  };
  const arch = await probeArchForPlan(body); // bounded read-only `uname -m`
  const { plan, planToken } = createSetupPlan({
    adminId,
    host: body.host,
    ports,
    deviceSerial: body.deviceSerial,
    sshFingerprint: body.sshFingerprint,
    arch,
    artifactChecksum: bundle.checksum,
    mode: body.mode,
  });
  const summary =
    `عملیات ${body.mode} روی ${body.host} انجام می‌شود: ` +
    `یک نسخه از بسته سرویس (checksum ${bundle.checksum.slice(0, 12)}…) در ${ADMS_RELEASES_DIR}/<checksum> منتشر می‌شود؛ ` +
    `فایل پیکربندی زمان اجرا (${ADMS_CONFIG_FILENAME} در ${ADMS_VAR_DIR} شامل توکن API و فهرست سریال‌ها) نوشته می‌شود و گواهی HTTPS در ${ADMS_ETC_DIR} نگهداری می‌شود؛ ` +
    `سرویس systemd با نام ${ADMS_SERVICE_NAME} برای حساب ${ADMS_ACCOUNT} ساخته و فعال می‌شود؛ ` +
    `دیتابیس ${ADMS_DB_FILE} و شناسه رکوردها دست‌نخورده می‌مانند و پیش از تغییر، پشتیبان سازگار گرفته می‌شود؛ ` +
    `فقط قوانین جدید UFW برای پورت‌های ${ports.deviceListener}/${ports.internalApi}/${ports.httpsApi} اضافه می‌شود (در صورت فعال بودن UFW)؛ هیچ قانون دیگری حذف، تغییر یا غیرفعال نمی‌شود و هیچ سرویس دیگری لمس نمی‌شود. ` +
    `پلن صادرشده حدود ۱۰ دقیقه اعتبار دارد و توکن آن یک‌بار مصرف است.`;

  await audit({
    userId: adminId,
    action: "terminal-adms-setup-plan",
    newValues: { host: body.host, mode: body.mode, deviceSerial: body.deviceSerial, artifactChecksum: bundle.checksum, ports },
  });

  return {
    action: "plan",
    planToken,
    plan: {
      planId: plan.planId,
      mode: plan.mode,
      host: plan.host,
      ports: plan.ports,
      deviceSerial: plan.deviceSerial,
      sshFingerprint: plan.sshFingerprint,
      arch: plan.arch,
      artifactChecksum: plan.artifactChecksum,
      issuedAt: plan.issuedAt,
      expiresAt: plan.expiresAt,
      nonce: plan.nonce,
    },
    summary,
  };
}

// ---------------- 4) install (NDJSON stream) ----------------

interface RemoteState {
  isRoot: boolean;
  namespace: Awaited<ReturnType<typeof probeNamespace>>;
}

async function collectRemoteState(session: SshSession, ports: SetupPlanPorts, emit: NdjsonEmitter): Promise<RemoteState> {
  const idRes = await execOk(session, "id -u", { timeoutMs: 6_000 });
  const isRoot = idRes.ok && idRes.stdout.trim() === "0";
  if (!isRoot) {
    emit.send({ type: "need-inspect", message: D.rootRequired });
    throw new FriendlyApiError(D.rootRequired);
  }
  const namespace = await probeNamespace(session);
  const portMap = await probePortMap(session, [...ADMS_SETUP_PORTS]);
  const assessment = assessNamespace(namespace, portMap, {
    deviceListener: ports.deviceListener,
    internalApi: ports.internalApi,
    httpsApi: ports.httpsApi,
  });
  if (!assessment.ok) {
    for (const c of assessment.conflicts) emit.send({ type: "need-inspect", message: c.message });
    throw new FriendlyApiError("تداخل با تنظیمات موجود سرور پیدا شد؛ عملیات متوقف شد. جزئیات را در پیام‌های بازرسی ببینید.");
  }
  return { isRoot, namespace };
}

async function ensureAccountAndDirs(session: SshSession): Promise<void> {
  const hasAccount = await execOk(session, `id -u ${ADMS_ACCOUNT} 2>/dev/null`, { timeoutMs: 6_000 });
  if (!hasAccount.ok) {
    await runDari(
      session,
      `useradd --system --home-dir ${ADMS_VAR_DIR} --no-create-home --shell /usr/sbin/nologin ${ADMS_ACCOUNT} 2>/dev/null || true`,
      10_000
    );
  }
  await runDari(
    session,
    `mkdir -p ${ADMS_OPT_DIR} ${ADMS_RELEASES_DIR} ${ADMS_ETC_DIR} ${ADMS_VAR_DIR} ${ADMS_VAR_DIR}/backups && ` +
      `chown ${ADMS_ACCOUNT}:${ADMS_ACCOUNT} ${ADMS_OPT_DIR} ${ADMS_RELEASES_DIR} ${ADMS_ETC_DIR} ${ADMS_VAR_DIR}`,
    15_000
  );
}

async function prepareDeps(session: SshSession, emit: NdjsonEmitter): Promise<void> {
  const python = await execOk(session, "python3 --version 2>&1 | head -c 60", { timeoutMs: 6_000 });
  if (!python.ok || !/python 3/i.test(python.stdout)) {
    emit.send({ type: "need-inspect", message: D.depsMissing });
    throw new FriendlyApiError(D.depsMissing);
  }
  const venv = await execOk(session, "python3 -c 'import venv' 2>/dev/null && echo ok || echo missing", { timeoutMs: 8_000 });
  if (venv.stdout.trim() !== "ok") {
    // Prepare deps BEFORE the current service is stopped. Only the
    // python3-venv package is touched — never unrelated packages.
    emit.send({ type: "log", message: "ماژول venv موجود نیست؛ نصب بسته python3-venv (فقط همین بسته)…" });
    const apt = await execOk(
      session,
      "DEBIAN_FRONTEND=noninteractive apt-get install -y python3-venv >/dev/null 2>&1 || " +
        "DEBIAN_FRONTEND=noninteractive apt-get install -y python3.10-venv >/dev/null 2>&1 || " +
        "DEBIAN_FRONTEND=noninteractive apt-get install -y python3.11-venv >/dev/null 2>&1 || echo failed",
      { timeoutMs: 180_000, maxBytes: 4 * 1024 }
    );
    if (apt.stdout.trim() === "failed" || !apt.ok) {
      emit.send({ type: "need-inspect", message: D.depsMissing });
      throw new FriendlyApiError(D.depsMissing);
    }
  }
  const venvDir = `${ADMS_OPT_DIR}/venv`;
  const created = await execOk(
    session,
    `[ -x ${venvDir}/bin/python ] && echo exists || python3 -m venv ${venvDir}`,
    { timeoutMs: 120_000 }
  );
  if (!created.ok) {
    emit.send({ type: "need-inspect", message: D.depsMissing });
    throw new FriendlyApiError("ساخت محیط مجازی پایتون روی سرور ناموفق بود.");
  }
}

async function backupPreviousState(
  session: SshSession,
  namespace: RemoteState["namespace"],
  emit: NdjsonEmitter
): Promise<string | null> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = `${ADMS_VAR_DIR}/backups/install-${ts}`;
  if (!namespace.dbFileExists && !namespace.serviceInstalled && !namespace.etc.exists) {
    return null; // nothing to back up on a pristine host
  }
  await runDari(session, `mkdir -p ${shQuote(backupDir)}`, 10_000);

  // Consistent SQLite backup: sqlite3 ".backup" first, python VACUUM INTO fallback.
  if (namespace.dbFileExists) {
    const viaSqlite = await execOk(
      session,
      `command -v sqlite3 >/dev/null 2>&1 && sqlite3 ${shQuote(ADMS_DB_FILE)} ".backup '${backupDir}/bicms-adms.db'" && echo ok || echo skip`,
      { timeoutMs: 60_000 }
    );
    if (viaSqlite.stdout.trim() !== "ok") {
      const backupDbPath = `${backupDir}/bicms-adms.db`;
      const py =
        `import sqlite3; sqlite3.connect(${JSON.stringify(ADMS_DB_FILE)})` +
        `.execute('VACUUM INTO ${JSON.stringify(backupDbPath)}')`;
      const viaPython = await execOk(session, `python3 -c ${shQuote(py)} && echo ok || echo failed`, { timeoutMs: 120_000 });
      if (viaPython.stdout.trim() !== "ok") {
        emit.send({ type: "need-inspect", message: D.dbBackupImpossible });
        throw new FriendlyApiError(D.dbBackupImpossible);
      }
    }
    emit.send({ type: "log", message: "پشتیبان سازگار دیتابیس گرفته شد (دست‌نخورده؛ فقط خواندن)." });
  }

  // Backup service unit + config tree (read-only copies).
  await execOk(session, `cp -a /etc/systemd/system/${ADMS_SERVICE_NAME} ${backupDir}/unit.bak 2>/dev/null || true`, { timeoutMs: 10_000 });
  await execOk(session, `tar -czf ${backupDir}/etc.tgz -C /etc aogc-bicms-adms 2>/dev/null || true`, { timeoutMs: 30_000 });
  emit.send({ type: "log", message: "پشتیبان سرویس و پیکربندی قبلی ذخیره شد." });
  return backupDir;
}

async function readExistingSecrets(
  session: SshSession
): Promise<{ token: string | null; serials: Record<string, unknown> | null; allowAnyNetwork: boolean | null; hasCert: boolean }> {
  const result: { token: string | null; serials: Record<string, unknown> | null; allowAnyNetwork: boolean | null; hasCert: boolean } = {
    token: null,
    serials: null,
    allowAnyNetwork: null,
    hasCert: false,
  };
  // Runtime config lives in the data dir: /var/lib/aogc-bicms-adms/bicms_adms.json
  const cfgRes = await execOk(session, `cat ${ADMS_VAR_DIR}/${ADMS_CONFIG_FILENAME} 2>/dev/null | head -c 8192`, { timeoutMs: 6_000 });
  if (cfgRes.ok && cfgRes.stdout.trim().startsWith("{")) {
    try {
      const json = JSON.parse(cfgRes.stdout) as Record<string, unknown>;
      const t = json.bearer_token ?? json.api_token ?? json.token;
      if (typeof t === "string" && t.length >= 16) result.token = t;
      if (json.serials && typeof json.serials === "object" && !Array.isArray(json.serials)) {
        result.serials = json.serials as Record<string, unknown>;
      }
      if (typeof json.allowAnyNetwork === "boolean") result.allowAnyNetwork = json.allowAnyNetwork;
    } catch {
      // unreadable/foreign config — treated as absent (never overwritten blindly)
    }
  }
  const certRes = await execOk(session, `[ -s ${ADMS_ETC_DIR}/tls.pem ] && echo yes || echo no`, { timeoutMs: 6_000 });
  result.hasCert = certRes.stdout.trim() === "yes";
  return result;
}

async function generateTokenRemote(session: SshSession): Promise<string> {
  const viaOpenssl = await execOk(session, "openssl rand -hex 32 2>/dev/null", { timeoutMs: 10_000 });
  if (viaOpenssl.ok && /^[0-9a-f]{64}$/.test(viaOpenssl.stdout.trim())) return viaOpenssl.stdout.trim();
  const viaPython = await execOk(session, "python3 -c 'import secrets; print(secrets.token_hex(32))' 2>/dev/null", { timeoutMs: 10_000 });
  if (viaPython.ok && /^[0-9a-f]{64}$/.test(viaPython.stdout.trim())) return viaPython.stdout.trim();
  throw new FriendlyApiError(D.tokenToolMissing);
}

async function ensureCertRemote(session: SshSession, host: string, hasCert: boolean, emit: NdjsonEmitter): Promise<void> {
  if (hasCert) {
    emit.send({ type: "log", message: "گواهی HTTPS موجود حفظ شد (بدون تغییر)." });
    return;
  }
  const hasOpenssl = await execOk(session, "command -v openssl >/dev/null 2>&1 && echo yes || echo no", { timeoutMs: 6_000 });
  if (hasOpenssl.stdout.trim() !== "yes") {
    emit.send({ type: "need-inspect", message: D.certToolMissing });
    throw new FriendlyApiError(D.certToolMissing);
  }
  // The runtime expects a COMBINED cert+key PEM at /etc/aogc-bicms-adms/tls.pem;
  // the app separately pins the CERT portion (tls.crt) as its trust anchor.
  await runDari(
    session,
    `openssl req -x509 -newkey rsa:2048 -nodes -keyout ${ADMS_ETC_DIR}/tls.key -out ${ADMS_ETC_DIR}/tls.crt ` +
      `-days 825 -subj ${shQuote(`/CN=${host}/O=AOGC BICMS`)} >/dev/null 2>&1 && ` +
      `cat ${ADMS_ETC_DIR}/tls.crt ${ADMS_ETC_DIR}/tls.key > ${ADMS_ETC_DIR}/tls.pem && ` +
      `chmod 600 ${ADMS_ETC_DIR}/tls.key ${ADMS_ETC_DIR}/tls.pem && chmod 644 ${ADMS_ETC_DIR}/tls.crt`,
    60_000
  );
  emit.send({ type: "log", message: "گواهی HTTPS تازه (self-signed) برای پین‌شدن در اپلیکیشن ساخته شد." });
}

/**
 * UFW: add ONLY the explicitly planned new-port allow rules (device,
 * internal, HTTPS). Never deletes, flushes or disables anything; never
 * touches unrelated rules. Rules are additive and stay put even on
 * rollback (reported honestly).
 */
async function addUfwRulesRemote(session: SshSession, ports: SetupPlanPorts, emit: NdjsonEmitter): Promise<void> {
  const status = await probeUfw(session);
  if (!status.available || !status.status) return;
  if (!/^Status:\s*active/im.test(status.status)) {
    emit.send({ type: "log", message: "UFW غیرفعال است؛ هیچ قانونی اضافه نشد." });
    return;
  }
  for (const port of [ports.deviceListener, ports.internalApi, ports.httpsApi]) {
    const has = await execOk(
      session,
      `ufw status 2>/dev/null | grep -E '(^|[[:space:]])${port}/tcp([[:space:]]|$)' >/dev/null && echo yes || echo no`,
      { timeoutMs: 10_000 }
    );
    if (has.stdout.trim() === "yes") continue;
    const added = await execOk(session, `ufw allow ${port}/tcp >/dev/null 2>&1 && echo ok || echo failed`, { timeoutMs: 15_000 });
    if (added.stdout.trim() === "ok") {
      emit.send({ type: "log", message: `قانون جدید UFW برای پورت ${port}/tcp اضافه شد (فقط این پورت).` });
    } else {
      emit.send({ type: "log", message: `افزودن قانون UFW برای پورت ${port} ناموفق بود؛ اگر فایروال جلوی دسترسی را بگیرد در تأیید نهایی دیده می‌شود.` });
    }
  }
}

/**
 * Write the runtime config (bicms_adms.json in the data dir).
 *
 * Matches the runtime's contract exactly: keys serials / allowAnyNetwork /
 * bearer_token / ports{device,internalApi,httpsApi}. Existing serial
 * allow-list entries are PRESERVED on upgrade/resume; the selected device
 * serial is added if missing. allowAnyNetwork stays false for fresh
 * installs (the pinned serial is the only registrable one).
 */
async function writeConfigRemote(
  session: SshSession,
  ports: SetupPlanPorts,
  token: string,
  deviceSerial: string,
  existing: { serials: Record<string, unknown> | null; allowAnyNetwork: boolean | null }
): Promise<void> {
  const serials: Record<string, unknown> = { ...(existing.serials ?? {}) };
  if (!serials[deviceSerial]) {
    serials[deviceSerial] = { note: "installed by BICMS setup wizard" };
  }
  const config = JSON.stringify(
    {
      allowAnyNetwork: existing.allowAnyNetwork ?? false,
      serials,
      bearer_token: token,
      ports: {
        device: ports.deviceListener,
        internalApi: ports.internalApi,
        httpsApi: ports.httpsApi,
      },
    },
    null,
    2
  );
  await writeFileRemote(session, `${ADMS_VAR_DIR}/${ADMS_CONFIG_FILENAME}`, config, "600");
  await runDari(session, `chown ${ADMS_ACCOUNT}:${ADMS_ACCOUNT} ${ADMS_VAR_DIR}/${ADMS_CONFIG_FILENAME}`, 10_000);
}

async function extractReleaseRemote(session: SshSession, artifact: BundleArtifact): Promise<string> {
  const releaseDir = `${ADMS_RELEASES_DIR}/${artifact.checksum}`;
  const verify = await execOk(session, `sha256sum ${shQuote(ADMS_BUNDLE_REMOTE_PATH)} 2>/dev/null | head -c 100`, { timeoutMs: 15_000 });
  const remoteSum = verify.stdout.split(/\s+/)[0] ?? "";
  if (!verify.ok || remoteSum !== artifact.checksum) {
    throw new FriendlyApiError(D.checksumMismatch);
  }
  await runDari(
    session,
    `mkdir -p ${shQuote(releaseDir)} && tar -xzf ${shQuote(ADMS_BUNDLE_REMOTE_PATH)} -C ${shQuote(releaseDir)} && ` +
      `chown -R ${ADMS_ACCOUNT}:${ADMS_ACCOUNT} ${shQuote(releaseDir)} && chmod -R u=rwX,go=rX ${shQuote(releaseDir)} && ` +
      `ln -sfn ${shQuote(`releases/${artifact.checksum}`)} ${ADMS_OPT_DIR}/current`,
    60_000
  );
  // `current` must be a symlink into releases/ — refuse foreign layouts.
  const linkCheck = await execOk(session, `readlink ${ADMS_OPT_DIR}/current 2>/dev/null`, { timeoutMs: 6_000 });
  if (!linkCheck.ok || !linkCheck.stdout.trim().startsWith("releases/")) {
    throw new FriendlyApiError(D.currentDirForeign);
  }
  return releaseDir;
}

async function installUnitRemote(session: SshSession): Promise<void> {
  await writeFileRemote(session, `/etc/systemd/system/${ADMS_SERVICE_NAME}`, SYSTEMD_UNIT_TEMPLATE, "644");
  await runDari(
    session,
    `systemctl daemon-reload && systemctl enable ${ADMS_SERVICE_NAME} >/dev/null 2>&1 || true`,
    20_000
  );
}

async function restartServiceRemote(session: SshSession, wasActive: boolean): Promise<void> {
  if (wasActive) {
    await runDari(session, `systemctl stop ${ADMS_SERVICE_NAME} 2>/dev/null || true`, 30_000);
  }
  await runDari(session, `systemctl restart ${ADMS_SERVICE_NAME}`, 30_000);
}

async function verifyListenersRemote(
  session: SshSession,
  ports: SetupPlanPorts,
  emit: NdjsonEmitter
): Promise<boolean> {
  const wanted = [ports.deviceListener, ports.internalApi, ports.httpsApi];
  for (let attempt = 0; attempt < 12; attempt++) {
    if (emit.closed) return false;
    const map = await probePortMap(session, wanted);
    const ok = wanted.every((p) => map.get(p)?.occupied === true);
    if (ok) {
      emit.send({ type: "log", message: `هر سه شنونده (${wanted.join("، ")}) فعال شدند.` });
      return true;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function rollback(
  session: SshSession,
  backupDir: string | null,
  prevRelease: string | null,
  prevServiceInstalled: boolean,
  prevServiceActive: boolean,
  emit: NdjsonEmitter
): Promise<{ attempted: boolean; recovered: boolean }> {
  emit.send({ type: "log", message: "بازگردانی نسخه قبلی آغاز شد…" });
  let recovered = true;
  try {
    if (prevRelease) {
      await execOk(session, `ln -sfn ${shQuote(`releases/${prevRelease}`)} ${ADMS_OPT_DIR}/current`, { timeoutMs: 10_000 });
    }
    if (backupDir) {
      const restored = await execOk(
        session,
        `tar -xzf ${backupDir}/etc.tgz -C /etc 2>/dev/null && echo ok || echo skip`,
        { timeoutMs: 30_000 }
      );
      if (restored.stdout.trim() !== "ok") recovered = false;
      await execOk(session, `[ -f ${backupDir}/unit.bak ] && cp -a ${backupDir}/unit.bak /etc/systemd/system/${ADMS_SERVICE_NAME} || true`, { timeoutMs: 10_000 });
    } else if (!prevServiceInstalled) {
      // Fresh install failed: remove the unit we added.
      await execOk(session, `systemctl disable ${ADMS_SERVICE_NAME} 2>/dev/null; rm -f /etc/systemd/system/${ADMS_SERVICE_NAME}`, { timeoutMs: 15_000 });
    }
    await execOk(session, "systemctl daemon-reload", { timeoutMs: 15_000 });
    if (prevServiceActive) {
      const restart = await execOk(session, `systemctl restart ${ADMS_SERVICE_NAME}`, { timeoutMs: 30_000 });
      if (!restart.ok) recovered = false;
    } else {
      await execOk(session, `systemctl stop ${ADMS_SERVICE_NAME} 2>/dev/null || true`, { timeoutMs: 30_000 });
    }
  } catch (e) {
    if (e instanceof AdmsConnectionLostError) throw e;
    recovered = false;
  }
  emit.send({
    type: "log",
    message: recovered
      ? "بازگردانی کامل شد؛ سرویس قبلی به وضعیت پیشین برگشت."
      : "بازگردانی کامل انجام نشد؛ سرور نیازمند بررسی دستی است.",
  });
  return { attempted: true, recovered };
}

export async function runInstall(emit: NdjsonEmitter, body: { planToken: string; password: string }, adminId: number): Promise<void> {
  let session: SshSession | null = null;
  let uploadedBundle = false;
  const overall = (percent: number) => emit.send({ type: "progress", percent, bytesSent: 0, bytesTotal: 0 });

  try {
    // ---- verify plan (signature, expiry, single-use, binding to bundle)
    const bundle = buildPythonBundle();
    const verification = await verifyPlanToken(body.planToken, {
      adminId,
      consume: true,
      artifactChecksum: bundle.checksum,
    });
    if (!verification.ok) {
      emit.send({ type: "error", message: verification.reason });
      return;
    }
    const plan = verification.plan;

    // ---- connect — host key is pinned BEFORE the password is sent
    emit.send({ type: "stage", stage: "connecting", message: "در حال اتصال به سرور…" });
    overall(5);
    try {
      session = await connectSsh({
        host: plan.host,
        port: plan.ports.ssh,
        username: "root",
        password: body.password,
        pinnedFingerprint: plan.sshFingerprint,
        timeoutMs: 12_000,
      });
    } catch (e) {
      if (e instanceof AdmsHostKeyError) {
        emit.send({ type: "error", message: D.sshFingerprintChanged });
        return;
      }
      if (e instanceof AdmsSshError) {
        emit.send({ type: "error", message: e.message });
        return;
      }
      throw e;
    }

    emit.send({ type: "stage", stage: "checking", message: "بررسی تداخل‌ها و وضعیت سرور…" });
    overall(15);
    const state = await collectRemoteState(session, plan.ports, emit);
    const prevRelease = state.namespace.currentRelease;
    const prevInstalled = state.namespace.serviceInstalled;
    const prevActive = state.namespace.serviceActive;

    // ---- prepare deps BEFORE stopping the current service
    overall(25);
    emit.send({ type: "log", message: "آماده‌سازی وابستگی‌ها (پیش از توقف سرویس قبلی)…" });
    await prepareDeps(session, emit);

    // ---- backups (consistent DB + unit + config) BEFORE changes
    overall(35);
    const backupDir = await backupPreviousState(session, state.namespace, emit);

    // ---- upload bundle with progress
    emit.send({ type: "stage", stage: "uploading", message: "انتقال بسته نصبی به سرور…" });
    try {
      await sftpUpload(session, bundle.path, ADMS_BUNDLE_REMOTE_PATH, (bytesSent, bytesTotal) => {
        const percent = bytesTotal > 0 ? Math.min(100, Math.floor((bytesSent / bytesTotal) * 100)) : 0;
        emit.send({ type: "progress", percent, bytesSent, bytesTotal });
      });
    } catch (e) {
      if (e instanceof AdmsConnectionLostError) throw e;
      emit.send({ type: "error", message: e instanceof AdmsSshError ? e.message : "انتقال بسته نصبی ناموفق بود." });
      return;
    }
    uploadedBundle = true;
    overall(45);
    emit.send({ type: "log", message: `بسته منتقل شد (${bundle.sizeBytes} بایت، checksum تأیید شد).` });

    // ---- release: checksum verify + extract + current symlink
    emit.send({ type: "stage", stage: "installing", message: "انتشار نسخه جدید سرویس…" });
    await ensureAccountAndDirs(session);
    await extractReleaseRemote(session, bundle);
    overall(55);

    // ---- config: preserve existing token/cert/serials on upgrade, fresh otherwise
    const existing = await readExistingSecrets(session);
    const token = existing.token ?? (await generateTokenRemote(session));
    await ensureCertRemote(session, plan.host, existing.hasCert, emit);
    await writeConfigRemote(session, plan.ports, token, plan.deviceSerial, {
      serials: existing.serials,
      allowAnyNetwork: existing.allowAnyNetwork,
    });
    overall(65);
    emit.send({ type: "log", message: "دیتابیس و شناسه رکوردهای موجود حفظ شدند (در مسیر خود باقی ماندند)." });

    // ---- UFW: only the explicitly planned new-port rules (never flush/disable)
    await addUfwRulesRemote(session, plan.ports, emit);

    // ---- systemd unit + config, then release switch, restart and verify.
    // Any failure from here on triggers the rollback path so the previous
    // service/config are restored and the recovery status is reported.
    let listenersOk = true;
    try {
      await installUnitRemote(session);
      overall(75);
      emit.send({ type: "stage", stage: "installing", message: "فعال‌سازی سرویس…" });
      await restartServiceRemote(session, prevActive);
      overall(85);

      // ---- verify ALL THREE listeners (not just one health response)
      emit.send({ type: "stage", stage: "verifying", message: "بررسی هر سه شنونده…" });
      listenersOk = await verifyListenersRemote(session, plan.ports, emit);
      overall(90);

      if (!listenersOk) {
        emit.send({ type: "log", message: D.listenersFailed });
        const recovery = await rollback(session, backupDir, prevRelease, prevInstalled, prevActive, emit);
        emit.send({
          type: "error",
          message: recovery.recovered
            ? "شنونده‌های سرویس فعال نشدند؛ نسخه قبلی سرویس و پیکربندی با موفقیت بازگردانده شد."
            : "شنونده‌های سرویس فعال نشدند و بازگردانی خودکار کامل نشد؛ بررسی دستی لازم است.",
        });
        return;
      }
    } catch (e) {
      if (e instanceof AdmsConnectionLostError) throw e; // uncertain outcome
      // Service was stopped/replaced — restore previous state before aborting.
      const recovery = await rollback(session, backupDir, prevRelease, prevInstalled, prevActive, emit);
      const detail = e instanceof AdmsSshError || e instanceof FriendlyApiError ? e.message : "خطای نامنتظره در فعال‌سازی سرویس.";
      emit.send({
        type: "error",
        message: `${detail} ` + (recovery.recovered
          ? "نسخه قبلی سرویس و پیکربندی بازگردانده شد."
          : "بازگردانی خودکار کامل نشد؛ بررسی دستی لازم است."),
      });
      return;
    }

    // ---- verify HTTPS API with the pinned cert (TLS verification stays ON)
    let caPem = "";
    let apiOk = false;
    try {
      const certBuf = await sftpReadFile(session, `${ADMS_ETC_DIR}/tls.crt`, { timeoutMs: 10_000 });
      caPem = certBuf.toString("utf8");
      const apiUrl = `https://${plan.host}:${plan.ports.httpsApi}`;
      const health = await admsApiHealth({ url: apiUrl, caPem, timeoutMs: 8000 });
      apiOk = health.reachable;
    } catch (e) {
      if (e instanceof AdmsConnectionLostError) throw e;
      apiOk = false;
    }

    if (!apiOk) {
      // Install itself succeeded; the API may be blocked (firewall/route).
      // Activation can be offered later WITHOUT reinstalling.
      emit.send({
        type: "need-inspect",
        message:
          "سرویس نصب و شنونده‌ها فعال شدند اما پاسخ HTTPS API از اپلیکیشن دریافت نشد. " +
          "احتمال: فایروال سرور، فایروال میزبان اپلیکیشن یا مسیر شبکه جلوی دسترسی را گرفته است. " +
          "فعال‌سازی می‌تواند بعداً بدون نصب مجدد انجام شود.",
      });
    }

    // ---- persist the encrypted connection profile (token from target config)
    const apiUrl = `https://${plan.host}:${plan.ports.httpsApi}`;
    let tokenSaved = false;
    try {
      writeConnectionProfile({ apiUrl, token, caPem, deviceUrl: `http://${plan.host}:${plan.ports.deviceListener}` });
      tokenSaved = true;
    } catch {
      tokenSaved = false;
    }

    await audit({
      userId: adminId,
      action: "terminal-adms-setup-install",
      newValues: { host: plan.host, mode: plan.mode, artifactChecksum: plan.artifactChecksum, listenersOk, apiOk, tokenSaved },
    });

    overall(100);
    emit.send({ type: "done", result: { apiUrl, caPem, tokenSaved, listenersOk, apiOk } });
  } catch (e) {
    if (e instanceof AdmsConnectionLostError) {
      // Outcome unknown — report honestly with the uncertain flag.
      emit.send({ type: "error", message: "اتصال SSH در میانه نصب قطع شد؛ وضعیت نهایی نصب نامعلوم است.", uncertain: true });
      return;
    }
    if (e instanceof AdmsSshError || e instanceof FriendlyApiError) {
      emit.send({ type: "error", message: e.message });
      return;
    }
    emit.send({ type: "error", message: "عملیات نصب با خطای نامنتظره متوقف شد." });
  } finally {
    // Best-effort cleanup of the uploaded tarball; never leaks the password.
    if (session) {
      if (uploadedBundle) {
        await execOk(session, `rm -f ${shQuote(ADMS_BUNDLE_REMOTE_PATH)}`, { timeoutMs: 8_000 }).catch(() => undefined);
      }
      session.end();
    }
  }
}

// ---------------- 5) activate ----------------

export async function activateAction(body: ActivateBody, adminId: number): Promise<ActivateOutcome> {
  const parsed = parseAdmsAddress(body.apiUrl, 8443, "https");
  if (!parsed || parsed.protocol !== "https") {
    throw new FriendlyApiError("آدرس API باید به شکل https://host:8443 باشد.");
  }
  const apiUrl = admsOrigin(parsed);
  const profile = readConnectionProfile(apiUrl);
  const caPem = body.caPem?.trim() || profile.caPem || "";
  const token = profile.token;
  if (!token) {
    throw new FriendlyApiError("توکن اتصال برای این آدرس ذخیره نشده است؛ ابتدا مرحله نصب/اتصال را کامل کنید.");
  }
  if (!caPem) {
    throw new FriendlyApiError("گواهی پین‌شده (CA) موجود نیست؛ فعال‌سازی بدون تأیید TLS مجاز نیست.");
  }

  // Live AUTHENTICATED health check over TLS with the pinned CA.
  // TLS verification is never disabled — rejectUnauthorized stays true.
  const health = await admsApiHealth({ url: apiUrl, bearerToken: token, caPem, timeoutMs: 8000 });
  if (!health.reachable) {
    throw new FriendlyApiError(`بررسی سلامت API ناموفق بود: ${health.message}`);
  }

  const existing = await resolveAdmsSettings();
  const device = parseAdmsAddress(profile.deviceUrl || existing.serverUrl || `http://${parsed.host}:8081`)!;
  writeConnectionProfile({ apiUrl, token, caPem, deviceUrl: admsOrigin(device) });
  await saveAdmsSettings({
    protocol: device.protocol, host: device.host, port: device.port, readEnabled: true,
    apiProtocol: parsed.protocol, apiHost: parsed.host, apiPort: parsed.port,
  }, adminId);
  invalidateAdmsSettingsCache();
  resetAdmsFeed(); // enabling reads → new baseline; history is never replayed

  await audit({
    userId: adminId,
    action: "terminal-adms-setup-activate",
    newValues: { apiUrl, readEnabled: true },
  });

  return {
    action: "activate",
    activated: true,
    settings: { protocol: device.protocol, host: device.host, port: device.port, readEnabled: true },
  };
}
