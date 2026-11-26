/**
 * Next.js instrumentation hook (runs once per server process start).
 *
 * Development convenience ONLY: in this sandbox the dedicated ADMS
 * runtime (`mini-services/adms-server/python`) cannot be started as a
 * standalone background service — the execution environment reaps
 * user-spawned background processes, so the connection check honestly
 * reports «سرور در دسترس نیست» even though the configuration is right.
 *
 * When the runtime is spawned as a CHILD of the Next.js server it
 * lives inside the server's own supervision, which matches the intended
 * deployment shape anyway: the ADMS runtime runs on the SAME machine as
 * the application backend (loopback application-facing API address,
 * 127.0.0.1:18082 here) while the device-facing listener is what
 * physical terminals point at.
 *
 * Production deployments are NOT affected: NODE_ENV=production never
 * autostarts anything — systemd owns the runtime there
 * (deploy/adms/aogc-bicms-adms.service). Opt out in dev with
 * ADMS_RUNTIME_AUTOSTART=0.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NODE_ENV === "production") return;
  if (process.env.ADMS_RUNTIME_AUTOSTART === "0") return;
  try {
    const { ensureDevAdmsRuntime } = await import("./instrumentation-adms");
    ensureDevAdmsRuntime();
  } catch (e) {
    console.warn("[adms-runtime] autostart skipped:", e instanceof Error ? e.message : e);
  }
}
