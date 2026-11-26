import "server-only";
import { Client, utils, type ClientChannel, type ConnectConfig, type SFTPWrapper } from "ssh2";
import { createHash } from "crypto";
import { statSync } from "fs";

// ============================================================
// Bounded SSH/SFTP transport for the ADMS setup wizard.
//
// Hard rules enforced here:
//   • The SSH password is used ONLY inside the ssh2 ConnectConfig
//     (in-memory) and keyboard-interactive replies. It is never
//     logged, never embedded in any Error message, never returned.
//   • When a fingerprint is pinned, host key verification happens
//     DURING the handshake — synchronously, BEFORE any password is
//     transmitted. A mismatch aborts the connection immediately.
//   • Every operation has a hard timeout and bounded output capture.
//   • TLS of the resulting ADMS API is handled elsewhere and is never
//     disabled (this module speaks SSH only).
// ============================================================

const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;

/** SSH-layer failure with a safe Dari message (never carries secrets). */
export class AdmsSshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdmsSshError";
  }
}

/** Host key mismatch — raised BEFORE authentication; password never sent. */
export class AdmsHostKeyError extends AdmsSshError {}

/** The SSH connection dropped mid-way — outcome of the step is unknown. */
export class AdmsConnectionLostError extends AdmsSshError {}

export function computeHostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64")}`;
}

function keyTypeOf(key: Buffer): string {
  try {
    const parsed = utils.parseKey(key);
    if (parsed instanceof Error) return "unknown";
    return parsed.type ?? "unknown";
  } catch {
    return "unknown";
  }
}

export interface CapturedHostKey {
  fingerprint: string;
  keyType: string;
}

/** Single-quote shell escaping for values interpolated into remote commands. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

interface ConnectOnceArgs {
  host: string;
  port: number;
  username?: string;
  password?: string;
  pinnedFingerprint?: string | null;
  captureOnly: boolean;
  timeoutMs: number;
}

interface LiveConnection {
  client: Client;
  hostKey: CapturedHostKey;
}

function connectOnce(args: ConnectOnceArgs): Promise<LiveConnection> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let hostKey: CapturedHostKey | null = null;
    let settled = false;
    let pinnedMismatch = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    let pollLimit: ReturnType<typeof setTimeout> | null = null;

    const stopPoll = () => {
      if (poll) clearInterval(poll);
      if (pollLimit) clearTimeout(pollLimit);
      poll = null;
      pollLimit = null;
    };
    const fail = (err: AdmsSshError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopPoll();
      try {
        client.end();
      } catch {
        // already dead — nothing to clean up
      }
      reject(err);
    };
    const succeed = (conn: LiveConnection) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopPoll();
      resolve(conn);
    };

    const timer = setTimeout(() => {
      fail(new AdmsSshError("اتصال SSH در زمان تعیین‌شده برقرار نشد."));
    }, args.timeoutMs);

    client.on("error", (err) => {
      if (pinnedMismatch) {
        fail(new AdmsHostKeyError(
          "اثر انگشت کلید SSH سرور با اثر ثبت‌شده مطابقت ندارد؛ عملیات قبل از ارسال پاسورد لغو شد."
        ));
        return;
      }
      const raw = String(err?.message ?? "");
      // Deliberately generic: ssh2/socket messages are never echoed raw.
      if (/all authentication/i.test(raw) || /authentication methods/i.test(raw)) {
        fail(new AdmsSshError("احراز هویت SSH ناموفق بود؛ نام کاربری یا پاسورد را بررسی کنید."));
      } else if (/timed out|timeout/i.test(raw)) {
        fail(new AdmsSshError("اتصال SSH در زمان تعیین‌شده برقرار نشد."));
      } else if (/host key verification/i.test(raw)) {
        fail(new AdmsHostKeyError("تأیید کلید میزبان SSH ناموفق بود."));
      } else {
        fail(new AdmsSshError("اتصال SSH برقرار نشد؛ آدرس و پورت را بررسی کنید."));
      }
    });

    client.on("close", () => {
      fail(new AdmsSshError("اتصال SSH بدون پاسخ بسته شد."));
    });

    client.on("ready", () => {
      if (!hostKey) {
        fail(new AdmsSshError("کلید میزبان SSH دریافت نشد."));
        return;
      }
      succeed({ client, hostKey });
    });

    client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
      // Password answers are fed in-memory only; never logged by ssh2.
      finish(prompts.map(() => args.password ?? ""));
    });

    const config: ConnectConfig = {
      host: args.host,
      port: args.port,
      readyTimeout: args.timeoutMs,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
      tryKeyboard: true,
      hostVerifier: (key: Buffer) => {
        hostKey = { fingerprint: computeHostKeyFingerprint(key), keyType: keyTypeOf(key) };
        if (args.pinnedFingerprint) {
          if (hostKey.fingerprint !== args.pinnedFingerprint) {
            pinnedMismatch = true;
            // Returning false destroys the transport BEFORE authentication
            // starts — the password is never transmitted in this path.
            return false;
          }
          return true;
        }
        return true; // fingerprint action: collect only, no auth follows
      },
    };

    if (args.captureOnly) {
      // No credentials exist for this phase. The host key is captured by
      // the verifier during key exchange (pre-auth); once captured we
      // succeed immediately and tear the probe connection down.
      config.username = "invalid-adms-probe";
      config.authHandler = () => false; // never send any real credential
    } else {
      config.username = args.username;
      config.password = args.password;
    }

    client.connect(config);

    if (args.captureOnly) {
      poll = setInterval(() => {
        if (hostKey) {
          succeed({ client, hostKey });
          setTimeout(() => {
            try {
              client.end();
            } catch {
              // ignore teardown races
            }
          }, 20);
        }
      }, 15);
      pollLimit = setTimeout(() => {
        fail(new AdmsSshError("کلید میزبان SSH از سرور دریافت نشد."));
      }, args.timeoutMs);
    }
  });
}

/** Connect WITHOUT any credential and return the server host key info. */
export async function getHostKeyFingerprint(
  host: string,
  port: number,
  timeoutMs = 8000
): Promise<CapturedHostKey> {
  const conn = await connectOnce({ host, port, captureOnly: true, timeoutMs });
  return conn.hostKey;
}

export interface SshSession {
  client: Client;
  hostKey: CapturedHostKey;
  /** true once the transport closed — later steps report "uncertain" */
  closed: boolean;
  end(): void;
}

/**
 * Authenticated connection. When `pinnedFingerprint` is provided the
 * host key is verified during the handshake — a mismatch aborts BEFORE
 * the password is sent (AdmsHostKeyError).
 */
export async function connectSsh(args: {
  host: string;
  port: number;
  username: string;
  password: string;
  pinnedFingerprint?: string | null;
  timeoutMs?: number;
}): Promise<SshSession> {
  const live = await connectOnce({
    host: args.host,
    port: args.port,
    username: args.username,
    password: args.password,
    pinnedFingerprint: args.pinnedFingerprint ?? null,
    captureOnly: false,
    timeoutMs: args.timeoutMs ?? 12_000,
  });
  const session: SshSession = {
    client: live.client,
    hostKey: live.hostKey,
    closed: false,
    end() {
      session.closed = true;
      try {
        live.client.end();
      } catch {
        // already dead
      }
    },
  };
  live.client.on("close", () => {
    session.closed = true;
  });
  return session;
}

export interface ExecOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  dropped: boolean;
}

/** Run one bounded command; stdout capture is capped (truncate at limit). */
export function execCommand(
  session: SshSession,
  command: string,
  options?: { timeoutMs?: number; maxBytes?: number }
): Promise<ExecOutcome> {
  const timeoutMs = options?.timeoutMs ?? 15_000;
  const maxBytes = options?.maxBytes ?? MAX_STDOUT_BYTES;
  return new Promise<ExecOutcome>((resolve, reject) => {
    if (session.closed) {
      return reject(new AdmsConnectionLostError("اتصال SSH از قبل قطع شده است."));
    }
    let stream: ClientChannel | null = null;
    let done = false;
    let timedOut = false;

    const settle = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        stream?.close();
      } catch {
        // stream already gone
      }
    }, timeoutMs);

    const onSessionClose = () => {
      settle(() => reject(new AdmsConnectionLostError("اتصال SSH در میانه اجرای دستور قطع شد.")));
    };
    session.client.once("close", onSessionClose);

    session.client.exec(command, (err, chan) => {
      if (err) {
        settle(() => reject(new AdmsSshError("اجرای دستور بازرسی از راه دور ناموفق بود.")));
        return;
      }
      stream = chan;
      let stdout = "";
      let stderr = "";
      let outBytes = 0;
      let errBytes = 0;
      let gotExit = false;
      let exitCode: number | null = null;
      chan.on("data", (d: Buffer) => {
        if (outBytes >= maxBytes) return; // bounded: hard-truncate
        outBytes += d.length;
        stdout += d.toString("utf8");
        if (outBytes >= maxBytes) stdout = stdout.slice(0, maxBytes);
      });
      chan.stderr.on("data", (d: Buffer) => {
        if (errBytes >= MAX_STDERR_BYTES) return;
        errBytes += d.length;
        stderr += d.toString("utf8");
        if (errBytes >= MAX_STDERR_BYTES) stderr = stderr.slice(0, MAX_STDERR_BYTES);
      });
      chan.on("exit", (code: number | null) => {
        gotExit = true;
        exitCode = code ?? null;
      });
      chan.on("close", () => {
        session.client.removeListener("close", onSessionClose);
        if (session.closed && !gotExit && !timedOut) {
          settle(() => reject(new AdmsConnectionLostError("اتصال SSH در میانه اجرای دستور قطع شد.")));
          return;
        }
        settle(() => resolve({ code: exitCode, stdout, stderr, timedOut, dropped: session.closed && !gotExit }));
      });
    });
  });
}

/** Convenience: exec that treats any rejection as a plain failure boolean. */
export async function execOk(
  session: SshSession,
  command: string,
  options?: { timeoutMs?: number; maxBytes?: number }
): Promise<{ ok: boolean; stdout: string; stderr: string; timedOut: boolean; dropped: boolean }> {
  try {
    const r = await execCommand(session, command, options);
    return { ok: r.code === 0 && !r.timedOut, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut, dropped: r.dropped };
  } catch (e) {
    if (e instanceof AdmsConnectionLostError) throw e;
    return { ok: false, stdout: "", stderr: e instanceof Error ? "probe failed" : "", timedOut: false, dropped: false };
  }
}

export interface UploadOutcome {
  bytesSent: number;
  bytesTotal: number;
}

/** SFTP upload with progress callbacks and a hard timeout. */
export function sftpUpload(
  session: SshSession,
  localPath: string,
  remotePath: string,
  onProgress: (bytesSent: number, bytesTotal: number) => void,
  timeoutMs = 180_000
): Promise<UploadOutcome> {
  return new Promise<UploadOutcome>((resolve, reject) => {
    if (session.closed) {
      return reject(new AdmsConnectionLostError("اتصال SSH از قبل قطع شده است."));
    }
    let bytesTotal = 0;
    try {
      bytesTotal = statSync(localPath).size;
    } catch {
      return reject(new AdmsSshError("فایل نصبی محلی پیدا نشد."));
    }

    let done = false;
    const cleanup = () => {
      clearTimeout(timer);
      session.client.removeListener("close", onClose);
    };
    const onClose = () => {
      if (done) return;
      done = true;
      cleanup();
      reject(new AdmsConnectionLostError("اتصال SSH در میانه انتقال فایل قطع شد."));
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new AdmsSshError("انتقال فایل به سرور در زمان تعیین‌شده کامل نشد."));
    }, timeoutMs);

    session.client.once("close", onClose);
    session.client.sftp((err, sftp: SFTPWrapper) => {
      if (done) {
        try {
          sftp?.end();
        } catch {
          // ignore
        }
        return;
      }
      if (err) {
        done = true;
        cleanup();
        return reject(new AdmsSshError("کانال انتقال فایل (SFTP) باز نشد."));
      }
      sftp.fastPut(localPath, remotePath, {
        step: (sent: number, _chunk: number, fsize: number) => {
          bytesTotal = fsize || bytesTotal;
          onProgress(sent, bytesTotal);
        },
      }, (putErr) => {
        if (done) return;
        done = true;
        cleanup();
        try {
          sftp.end();
        } catch {
          // ignore
        }
        if (putErr) {
          reject(new AdmsSshError("انتقال فایل به سرور ناموفق بود."));
        } else {
          resolve({ bytesSent: bytesTotal, bytesTotal });
        }
      });
    });
  });
}

/** Bounded SFTP read (used to fetch the pinned self-signed cert PEM). */
export function sftpReadFile(
  session: SshSession,
  remotePath: string,
  options?: { timeoutMs?: number; maxBytes?: number }
): Promise<Buffer> {
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const maxBytes = options?.maxBytes ?? 64 * 1024;
  return new Promise<Buffer>((resolve, reject) => {
    if (session.closed) {
      return reject(new AdmsConnectionLostError("اتصال SSH از قبل قطع شده است."));
    }
    let done = false;
    const cleanup = () => {
      clearTimeout(timer);
      session.client.removeListener("close", onClose);
    };
    const onClose = () => {
      if (done) return;
      done = true;
      cleanup();
      reject(new AdmsConnectionLostError("اتصال SSH در میانه خواندن فایل قطع شد."));
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new AdmsSshError("خواندن فایل از سرور در زمان تعیین‌شده کامل نشد."));
    }, timeoutMs);

    session.client.once("close", onClose);
    session.client.sftp((err, sftp: SFTPWrapper) => {
      if (done) return;
      if (err) {
        done = true;
        cleanup();
        return reject(new AdmsSshError("کانال انتقال فایل (SFTP) باز نشد."));
      }
      let chunks: Buffer[] = [];
      let bytes = 0;
      const rs = sftp.createReadStream(remotePath);
      rs.on("data", (d: Buffer) => {
        bytes += d.length;
        if (bytes > maxBytes) {
          rs.destroy();
          return;
        }
        chunks.push(d);
      });
      const finishOk = () => {
        if (done) return;
        done = true;
        cleanup();
        try {
          sftp.end();
        } catch {
          // ignore
        }
        resolve(Buffer.concat(chunks));
      };
      const finishErr = (message: string) => {
        if (done) return;
        done = true;
        cleanup();
        try {
          sftp.end();
        } catch {
          // ignore
        }
        chunks = [];
        reject(new AdmsSshError(message));
      };
      rs.on("end", finishOk);
      rs.on("error", () => finishErr("فایل مورد نظر روی سرور خوانده نشد."));
      rs.on("close", () => {
        // 'close' may fire after 'end' — only treat as failure if unsettled
        if (!done) finishOk();
      });
    });
  });
}
