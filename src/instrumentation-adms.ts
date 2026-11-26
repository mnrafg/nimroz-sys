import { spawn, execFileSync, type ChildProcess } from "child_process";
import { existsSync, createWriteStream } from "fs";
import { createConnection } from "net";
import { join } from "path";

// ============================================================
// Supervised development ADMS runtime.
//
// Spawns the dedicated Python ADMS service (mini-services/adms-server)
// as a child of the Next.js dev server so the loopback application-
// facing API (127.0.0.1:18082) is genuinely reachable and the admin
// connection check reports the REAL service state.
//
// Why a child of the server: the sandbox execution environment reaps
// independently-spawned background processes; a runtime owned by the
// Next.js server lives under the same supervision as the app itself —
// which also matches the intended deployment shape (the ADMS runtime
// runs on the SAME machine as the application backend; the loopback
// API address is exactly the "local service/tunnel" case, while the
// device-facing listener stays a SEPARATE concept that is never
// invented here).
//
// Safety rails:
//  • never runs in production (systemd owns the runtime there —
//    deploy/adms/aogc-bicms-adms.service)
//  • idempotent: port probe + a globalThis guard survive HMR
//  • never blocks or crashes the app when python/the runtime is absent
//  • never invents a device-facing destination for terminals
// ============================================================

const RUNTIME_DIR = join(process.cwd(), "mini-services", "adms-server", "python");
const API_PROBE_HOST = "127.0.0.1";
const API_PROBE_PORT = 18082;

/** True when something already listens on the loopback API port. */
function apiPortBusy(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host: API_PROBE_HOST, port: API_PROBE_PORT, timeout: 1500 });
    const done = (busy: boolean) => {
      sock.destroy();
      resolve(busy);
    };
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

/** Interpreter probe result. */
function pythonImportsRuntime(python: string): boolean {
  try {
    execFileSync(python, ["-c", "import fastapi, uvicorn"], { timeout: 8000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Find a python3 that can actually run the runtime. The dev server's
 * PATH may resolve `python3` to an interpreter WITHOUT fastapi/uvicorn
 * (and without ensurepip, so run.sh's venv bootstrap would fail too);
 * run.sh honors BICMS_ADMS_PYTHON, so we resolve a WORKING interpreter
 * explicitly. Returns null when none qualifies (autostart then honestly
 * does not happen — the connection check reports the real state).
 */
function resolveRuntimePython(): string | null {
  const candidates = [
    process.env.BICMS_ADMS_PYTHON,
    "python3",
    "/home/z/.venv/bin/python3",
    "/usr/bin/python3",
    "/usr/local/bin/python3",
  ].filter((p): p is string => !!p);
  for (const candidate of candidates) {
    if (pythonImportsRuntime(candidate)) return candidate;
  }
  return null;
}

/** Module/HMR-safe one-shot marker (shared across route re-instanciations). */
const G = globalThis as typeof globalThis & { __admsRuntimeChild?: ChildProcess };

function devAutostartAllowed(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  if (process.env.ADMS_RUNTIME_AUTOSTART === "0") return false;
  return true;
}

async function spawnRuntime(): Promise<void> {
  const entry = join(RUNTIME_DIR, "bicms_adms.py");
  const launcher = join(RUNTIME_DIR, "run.sh");
  if (!existsSync(entry) || !existsSync(launcher)) {
    console.warn(`[adms-runtime] runtime files not found under ${RUNTIME_DIR} — autostart skipped`);
    return;
  }

  const python = resolveRuntimePython();
  if (!python) {
    console.warn(
      "[adms-runtime] no python3 with fastapi+uvicorn found (checked BICMS_ADMS_PYTHON, PATH, common venv paths) — autostart skipped; the connection check will report the service as unreachable, which is then the true state."
    );
    return;
  }

  const logPath = join(RUNTIME_DIR, "adms-runtime.log");
  const child = spawn("bash", [launcher], {
    cwd: RUNTIME_DIR,
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      // run.sh execs this interpreter directly when fastapi/uvicorn are
      // importable — bypassing its venv bootstrap entirely.
      BICMS_ADMS_PYTHON: python,
      BICMS_ADMS_DATA_DIR: join(RUNTIME_DIR, "tmp-data"),
      // Sandbox listener layout: device-facing 18081, loopback
      // application API 18082, TLS API 18443 — the ports the saved
      // connection profile (127.0.0.1:18082) expects.
      BICMS_ADMS_PORTS: JSON.stringify({ device: 18081, internalApi: 18082, httpsApi: 18443 }),
    },
  });

  const logStream = createWriteStream(logPath, { flags: "a" });
  logStream.write(`\n===== spawn ${new Date().toISOString()} =====\n`);
  child.stdout?.pipe(logStream, { end: false });
  child.stderr?.pipe(logStream, { end: false });

  child.once("exit", (code, signal) => {
    console.warn(`[adms-runtime] exited code=${code ?? "-"} signal=${signal ?? "-"}`);
    if (G.__admsRuntimeChild === child) G.__admsRuntimeChild = undefined;
  });

  // Never let the child keep the event loop alive on shutdown.
  child.unref();
  G.__admsRuntimeChild = child;

  console.log(
    `[adms-runtime] spawned pid=${child.pid} device=:18081 api=127.0.0.1:18082 tls=:18443 (dev supervision)`
  );
}

/**
 * Idempotent dev autostart. Fire-and-forget: callers may `void` it —
 * it logs everything it does and never throws.
 */
export function ensureDevAdmsRuntime(): void {
  if (!devAutostartAllowed()) return;
  void (async () => {
    try {
      if (G.__admsRuntimeChild && !G.__admsRuntimeChild.killed) return;
      if (await apiPortBusy()) {
        console.log(`[adms-runtime] ${API_PROBE_HOST}:${API_PROBE_PORT} already serving — nothing to start`);
        return;
      }
      await spawnRuntime();
    } catch (e) {
      console.warn("[adms-runtime] autostart failed:", e instanceof Error ? e.message : e);
    }
  })();
}
