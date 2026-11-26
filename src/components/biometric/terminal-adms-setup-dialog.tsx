"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Fingerprint,
  Info,
  KeyRound,
  Loader2,
  MonitorSmartphone,
  Radio,
  ScrollText,
  Server,
  ShieldAlert,
  Wand2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiFetch } from "@/lib/client-api";
import { formatJalaliDateTime, toPersianDigits } from "@/lib/jalali";
import { cn } from "@/lib/utils";
import type { TerminalDeviceRow } from "@/components/biometric/terminal-devices-panel";

// ============================================================
// راه‌اندازی و بررسی سرور ADMS — multi-step admin wizard.
//
// fingerprint → inspect → plan → install (NDJSON stream) → activate.
//
// Security posture mirrored in the UI:
//  • the SSH password is TRANSIENT — used once per request and never
//    stored anywhere (never prefilled, never echoed as text)
//  • the SSH host key is pinned by SHA256 fingerprint, verified by the
//    admin against an INDEPENDENT source before install may start
//  • every observed fact stays labelled as a fact — never as proof of
//    end-to-end connectivity
// ============================================================

interface InspectFacts {
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

type ListenerOccupancy = { occupied: boolean; byWhom: string | null };

interface InspectResult {
  facts: InspectFacts;
  listeners: {
    ssh: ListenerOccupancy;
    deviceListener: ListenerOccupancy;
    internalApi: ListenerOccupancy;
    httpsApi: ListenerOccupancy;
  };
  deviceObservations: { seenRequests: boolean; lastSeen: string | null };
  findings: string[];
  planProposal: { mode: string; reason: string };
}

interface PlanResult {
  planToken: string;
  plan: {
    planId: string;
    mode: string;
    host: string;
    ports: { ssh: number; deviceListener: number; internalApi: number; httpsApi: number };
    deviceSerial: string;
    sshFingerprint: string;
    arch: string;
    artifactChecksum: string;
    issuedAt: number;
    expiresAt: number;
  };
  summary: string;
}

interface InstallResult {
  apiUrl: string;
  caPem: string;
  tokenSaved: boolean;
  listenersOk: boolean;
  apiOk: boolean;
}

interface ActivateResponse {
  action: "activate";
  activated: boolean;
  settings: { protocol: string; host: string; port: number; readEnabled: boolean };
}

type SetupStage = "connecting" | "checking" | "uploading" | "installing" | "verifying";

const STAGE_LABELS: Record<SetupStage, string> = {
  connecting: "در حال اتصال",
  checking: "بررسی",
  uploading: "بارگذاری",
  installing: "نصب",
  verifying: "بررسی نهایی",
};

const MODE_LABELS: Record<string, string> = {
  install: "نصب کامل",
  resume: "ادامه نصب",
  connect: "اتصال به نصب موجود",
  upgrade: "ارتقای نصب موجود",
};

const LISTENER_LABELS: Record<string, string> = {
  ssh: "پورت SSH",
  deviceListener: "شنونده دستگاه",
  internalApi: "API داخلی",
  httpsApi: "API امن (HTTPS)",
};

const STEP_LABELS = ["سرور", "اثر انگشت", "بررسی", "پلن", "نصب", "فعال‌سازی"];

const IPv4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIPv4(v: string): boolean {
  const m = IPv4_RE.exec(v.trim());
  if (!m) return false;
  return m.slice(1).every((oct) => {
    const n = Number(oct);
    return n >= 0 && n <= 255;
  });
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${toPersianDigits((n / (1024 * 1024)).toFixed(1))} مگابایت`;
  if (n >= 1024) return `${toPersianDigits(Math.round(n / 1024))} کیلوبایت`;
  return `${toPersianDigits(n)} بایت`;
}

function FactDot({ ok }: { ok: boolean }) {
  return ok ? (
    <Check className="size-3.5 shrink-0 text-success" aria-label="موجود" />
  ) : (
    <X className="size-3.5 shrink-0 text-danger" aria-label="موجود نیست" />
  );
}

export function TerminalAdmsSetupDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const queryClient = useQueryClient();

  // ---------- wizard state ----------
  const [step, setStep] = React.useState(1);
  const [host, setHost] = React.useState("");
  const [sshPort, setSshPort] = React.useState("22");
  const [deviceKey, setDeviceKey] = React.useState<string | null>(null);
  const [fingerprint, setFingerprint] = React.useState<string | null>(null);
  const [keyType, setKeyType] = React.useState<string | null>(null);
  const [fpConfirmed, setFpConfirmed] = React.useState(false);
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [inspect, setInspect] = React.useState<InspectResult | null>(null);
  const [plan, setPlan] = React.useState<PlanResult | null>(null);
  const [planConfirmed, setPlanConfirmed] = React.useState(false);
  const [installStage, setInstallStage] = React.useState<SetupStage | null>(null);
  const [progress, setProgress] = React.useState<{ percent: number; bytesSent: number; bytesTotal: number } | null>(null);
  const [logs, setLogs] = React.useState<string[]>([]);
  const [needInspectMsg, setNeedInspectMsg] = React.useState<string | null>(null);
  const [installError, setInstallError] = React.useState<{ message: string; uncertain: boolean } | null>(null);
  const [installResult, setInstallResult] = React.useState<InstallResult | null>(null);
  const [activateError, setActivateError] = React.useState<string | null>(null);
  const logBoxRef = React.useRef<HTMLDivElement | null>(null);

  const reset = () => {
    setStep(1);
    setHost("");
    setSshPort("22");
    setDeviceKey(null);
    setFingerprint(null);
    setKeyType(null);
    setFpConfirmed(false);
    setUsername("");
    setPassword("");
    setInspect(null);
    setPlan(null);
    setPlanConfirmed(false);
    setInstallStage(null);
    setProgress(null);
    setLogs([]);
    setNeedInspectMsg(null);
    setInstallError(null);
    setInstallResult(null);
    setActivateError(null);
  };

  React.useEffect(() => {
    if (open) reset();
  }, [open]);

  // ---------- physical device for the plan ----------
  const devicesQ = useQuery({
    queryKey: ["terminal-devices", "setup-wizard"],
    queryFn: () => apiFetch<{ devices: TerminalDeviceRow[] }>("/api/biometric/terminal/devices"),
    enabled: open,
  });
  const eligibleDevices = (devicesQ.data?.devices ?? []).filter((d) => d.isEnabled);

  // Auto-select when exactly one eligible device exists (never arbitrary);
  // a cleared/removed device never stays selected silently.
  React.useEffect(() => {
    const devs = (devicesQ.data?.devices ?? []).filter((d) => d.isEnabled);
    if (devs.length === 1) {
      setDeviceKey(devs[0].serial);
    } else if (deviceKey && !devs.some((d) => d.serial === deviceKey)) {
      setDeviceKey(null);
    }
  }, [devicesQ.data, deviceKey]);

  const selectedDevice = eligibleDevices.find((d) => d.serial === deviceKey) ?? null;

  // ---------- step 1 validation ----------
  const step1Valid = isIPv4(host) && Number(sshPort) >= 1 && Number(sshPort) <= 65535 && !!selectedDevice;

  // ---------- step 2 — fingerprint ----------
  const fingerprintM = useMutation({
    mutationFn: () =>
      apiFetch<{ fingerprint: string; keyType: string }>("/api/biometric/terminal/adms-server/setup", {
        method: "POST",
        body: JSON.stringify({ action: "fingerprint", host: host.trim(), sshPort: Number(sshPort) }),
      }),
    onSuccess: (res) => {
      setFingerprint(res.fingerprint);
      setKeyType(res.keyType);
      setFpConfirmed(false);
      setStep(2);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ---------- step 3 — inspect ----------
  const inspectM = useMutation({
    mutationFn: () =>
      apiFetch<InspectResult>("/api/biometric/terminal/adms-server/setup", {
        method: "POST",
        body: JSON.stringify({
          action: "inspect",
          host: host.trim(),
          sshPort: Number(sshPort),
          username: username.trim(),
          password,
          deviceSerial: selectedDevice?.serial ?? "",
        }),
      }),
    onSuccess: (res) => {
      setInspect(res);
      setStep(4);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ---------- step 4 — plan ----------
  const planM = useMutation({
    mutationFn: () =>
      apiFetch<PlanResult>("/api/biometric/terminal/adms-server/setup", {
        method: "POST",
        body: JSON.stringify({
          action: "plan",
          host: host.trim(),
          sshPort: Number(sshPort),
          username: username.trim(),
          deviceSerial: selectedDevice?.serial ?? "",
          ports: { deviceListener: 8081, internalApi: 8082, httpsApi: 8443, ssh: Number(sshPort) },
          password,
          mode: (inspect?.planProposal.mode ?? "install") as string,
          sshFingerprint: fingerprint ?? "",
        }),
      }),
    onSuccess: (res) => {
      setPlan(res);
      setPlanConfirmed(false);
      setStep(5);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ---------- step 5 — install as an NDJSON STREAM ----------
  const [installing, setInstalling] = React.useState(false);

  const startInstall = async () => {
    if (!plan) return;
    setInstalling(true);
    setInstallError(null);
    setNeedInspectMsg(null);
    setInstallStage("connecting");
    let sawDone = false;
    let sawError = false;
    const handleInstallEvent = (ev: Record<string, unknown>) => {
      const type = ev.type;
      if (type === "stage") {
        setInstallStage(ev.stage as SetupStage);
      } else if (type === "progress") {
        setProgress({
          percent: Math.max(0, Math.min(100, Number(ev.percent) || 0)),
          bytesSent: Number(ev.bytesSent) || 0,
          bytesTotal: Number(ev.bytesTotal) || 0,
        });
      } else if (type === "log") {
        setLogs((prev) => [...prev.slice(-299), String(ev.message ?? "")]);
      } else if (type === "need-inspect") {
        setNeedInspectMsg(String(ev.message ?? "بررسی دستی لازم است."));
      } else if (type === "done") {
        sawDone = true;
        setInstallResult(ev.result as InstallResult);
        setStep(6);
        toast.success("نصب سرویس ADMS با موفقیت کامل شد.");
      } else if (type === "error") {
        sawError = true;
        setInstallError({ message: String(ev.message ?? "نصب ناموفق بود."), uncertain: Boolean(ev.uncertain) });
      }
    };
    try {
      const res = await fetch("/api/biometric/terminal/adms-server/setup", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "install", planToken: plan.planToken, password }),
      });
      if (!res.ok || !res.body) {
        let msg = "جریان نصب برقرار نشد.";
        try {
          const j = (await res.json()) as { error?: string };
          if (j?.error) msg = j.error;
        } catch {
          // non-JSON error
        }
        setInstallError({ message: msg, uncertain: false });
        setInstalling(false);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          try {
            handleInstallEvent(JSON.parse(line) as Record<string, unknown>);
          } catch {
            // a malformed/partial line is skipped safely; the stream
            // continues with the next complete line
          }
        }
      }
      if (!sawDone && !sawError) {
        setInstallError({ message: "جریان نصب بدون پیام پایان بسته شد.", uncertain: true });
      }
    } catch (e) {
      setInstallError({ message: (e as Error).message ?? "ارتباط با سرور حین نصب قطع شد.", uncertain: true });
    } finally {
      setInstalling(false);
    }
  };

  // auto-scroll the log box
  React.useEffect(() => {
    const el = logBoxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  // ---------- step 6 — activate ----------
  const activateM = useMutation({
    mutationFn: () =>
      apiFetch<ActivateResponse>("/api/biometric/terminal/adms-server/setup", {
        method: "POST",
        body: JSON.stringify({
          action: "activate",
          apiUrl: installResult?.apiUrl ?? "",
          caPem: installResult?.caPem ?? undefined,
        }),
      }),
    onSuccess: () => {
      toast.success("اتصال سرور ADMS فعال شد و پس از بررسی امن TLS ثبت گردید.");
      void queryClient.invalidateQueries({ queryKey: ["terminal-adms-settings"] });
      void queryClient.invalidateQueries({ queryKey: ["terminal-devices"] });
      setActivated(true);
    },
    onError: (e: Error) => setActivateError(e.message),
  });

  const [activated, setActivated] = React.useState(false);
  React.useEffect(() => {
    if (open && step === 1) setActivated(false);
  }, [open, step]);

  // password origin check — HTTPS origin OR localhost; otherwise a
  // warning is shown (local http dev stays possible but is flagged).
  const [originOk, setOriginOk] = React.useState(true);
  React.useEffect(() => {
    const isHttps = window.location.protocol === "https:";
    const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
    setOriginOk(isHttps || isLocal);
  }, []);

  const busy = fingerprintM.isPending || inspectM.isPending || planM.isPending || installing || activateM.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <WandIcon />
            راه‌اندازی و بررسی سرور ADMS
          </DialogTitle>
          <DialogDescription>
            نصب سرویس پایتونی ADMS روی سرور مقصد از طریق SSH — با پین‌کردن اثر انگشت کلید و پلن تأییدشده.
          </DialogDescription>
        </DialogHeader>

        {/* step chips */}
        <div className="flex flex-wrap items-center gap-1.5" role="list" aria-label="مراحل راه‌اندازی">
          {STEP_LABELS.map((label, i) => {
            const n = i + 1;
            const done = step > n || (activated && n === 6);
            return (
              <span
                key={label}
                role="listitem"
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
                  step === n
                    ? "bg-secondary text-primary border-primary/30"
                    : done
                      ? "bg-success-soft text-success border-success/30"
                      : "bg-card text-muted-foreground border-border"
                )}
              >
                {done ? <Check className="size-3" aria-hidden /> : <span>{toPersianDigits(n)}.</span>}
                {label}
              </span>
            );
          })}
        </div>

        <div className="max-h-[52vh] overflow-y-auto pe-1 space-y-3">
          {/* ---------------- Step 1: server + device ---------------- */}
          {step === 1 && (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="setup-host">سرور عمومی IPv4</Label>
                  <Input
                    id="setup-host"
                    dir="ltr"
                    className="text-left font-mono"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="193.181.211.71"
                    autoFocus
                  />
                  {host && !isIPv4(host) && (
                    <p className="text-xs text-danger">آدرس باید یک IPv4 معتبر باشد (مثلاً 193.181.211.71).</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="setup-ssh-port">پورت SSH</Label>
                  <Input
                    id="setup-ssh-port"
                    dir="ltr"
                    className="text-left font-mono"
                    inputMode="numeric"
                    value={sshPort}
                    onChange={(e) => setSshPort(e.target.value.replace(/[^0-9]/g, ""))}
                    placeholder="22"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="setup-device">انتخاب دستگاه فیزیکی</Label>
                <Select
                  value={deviceKey ?? ""}
                  onValueChange={(v) => setDeviceKey(v)}
                >
                  <SelectTrigger id="setup-device">
                    <SelectValue placeholder={devicesQ.isLoading ? "در حال بارگذاری…" : "انتخاب دستگاه"} />
                  </SelectTrigger>
                  <SelectContent className="max-h-56">
                    {eligibleDevices.map((d) => (
                      <SelectItem key={d.serial} value={d.serial}>
                        {d.name} — <span dir="ltr" className="font-mono">{d.serial}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  سریال این دستگاه در پلن نصب ثبت می‌شود تا سرویس، اسکن‌های همان ترمینال را پیوند دهد.
                  {eligibleDevices.length === 0 && " — هیچ دستگاه فعالی ثبت نشده است."}
                </p>
              </div>
              <div className="rounded-lg border border-info/30 bg-info-soft px-3 py-2 text-[11px] leading-5 flex items-start gap-1.5">
                <Info className="size-3.5 mt-0.5 shrink-0" aria-hidden />
                <span>
                  برای راه‌اندازی استاندارد، IP عمومی روتر سایت دستگاه لازم نیست؛ سرور مقصد است —
                  دستگاه خودش به شنونده سرور متصل می‌شود.
                </span>
              </div>
              <div className="flex justify-start">
                <Button
                  onClick={() => fingerprintM.mutate()}
                  disabled={!step1Valid || fingerprintM.isPending}
                  className="min-h-11 gap-1.5"
                >
                  {fingerprintM.isPending ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <Fingerprint className="size-4" aria-hidden />
                  )}
                  دریافت اثر انگشت سرور
                </Button>
              </div>
            </div>
          )}

          {/* ---------------- Step 2: fingerprint pinning ---------------- */}
          {step === 2 && (
            <div className="space-y-3">
              {fingerprint ? (
                <>
                  <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
                    <div className="text-xs text-muted-foreground">
                      اثر انگشت کلید میزبان ({keyType ?? "SSH"}) — SHA256:
                    </div>
                    <div className="font-mono text-xs break-all bg-card border rounded px-2 py-1.5" dir="ltr">
                      {fingerprint}
                    </div>
                  </div>
                  <div className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-[11px] leading-5 flex items-start gap-1.5">
                    <ShieldAlert className="size-3.5 mt-0.5 shrink-0 text-warning" aria-hidden />
                    <span>
                      این اثر انگشت را از یک منبع معتبر مستقل تطبیق دهید؛ پس از تأیید ادامه دهید.
                    </span>
                  </div>
                  <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                    <Checkbox
                      checked={fpConfirmed}
                      onCheckedChange={(v) => setFpConfirmed(v === true)}
                      aria-label="اثر انگشت را تأیید کردم"
                    />
                    اثر انگشت را تأیید کردم
                  </label>
                </>
              ) : (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                  <Loader2 className="size-4 animate-spin" aria-hidden /> در حال دریافت اثر انگشت…
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => setStep(3)}
                  disabled={!fingerprint || !fpConfirmed}
                  className="min-h-11"
                >
                  ادامه
                </Button>
                <Button variant="outline" onClick={() => setStep(1)} className="min-h-11">
                  بازگشت
                </Button>
              </div>
            </div>
          )}

          {/* ---------------- Step 3: SSH credentials + inspect ---------------- */}
          {step === 3 && (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="setup-user">نام کاربری SSH</Label>
                  <Input
                    id="setup-user"
                    dir="ltr"
                    className="text-left font-mono"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="off"
                    placeholder="root"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="setup-pass">پورد موقت SSH</Label>
                  <Input
                    id="setup-pass"
                    type="password"
                    dir="ltr"
                    className="text-left font-mono"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                  />
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground leading-5">
                پاسورد فقط در حافظه همین درخواست استفاده می‌شود و در بانک اطلاعاتی، مرورگر یا لاگ ذخیره نمی‌شود.
              </p>
              {!originOk && (
                <div className="rounded-md border border-warning/30 bg-warning-soft text-warning text-xs p-2.5 leading-5">
                  این پنجره روی HTTP ساده باز است؛ ارسال پاسورد از طریق یک کانال امن (HTTPS) توصیه می‌شود.
                </div>
              )}
              {inspectM.isPending ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                  <Loader2 className="size-4 animate-spin" aria-hidden /> در حال بررسی سرور…
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={() => inspectM.mutate()}
                    disabled={!username.trim() || !password || !selectedDevice || inspectM.isPending}
                    className="min-h-11 gap-1.5"
                  >
                    <KeyRound className="size-4" aria-hidden />
                    بررسی سرور
                  </Button>
                  <Button variant="outline" onClick={() => setStep(2)} className="min-h-11">
                    بازگشت
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* ---------------- Step 3.5 shown inline: inspection results (step 4 header below keeps numbering stable) ---------------- */}
          {step === 4 && inspect && (
            <div className="space-y-3">
              <div className="rounded-lg border bg-muted/20 p-3 space-y-2 text-xs">
                <div className="font-semibold flex items-center gap-1.5">
                  <Server className="size-3.5" aria-hidden />
                  مشاهده‌شده‌های سرور (حقایق — نه اثبات اتصال کامل)
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
                  <span className="flex items-center gap-1.5">
                    <FactDot ok={!!inspect.facts.os} /> سیستم‌عامل: {inspect.facts.os ?? "—"}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <FactDot ok={inspect.facts.archSupported} /> معماری: {inspect.facts.arch ?? "—"}
                    {!inspect.facts.archSupported && <span className="text-danger">(نامورد)</span>}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <FactDot ok={inspect.facts.systemdPresent} /> systemd
                  </span>
                  <span className="flex items-center gap-1.5">
                    <FactDot ok={inspect.facts.python3.present} /> Python 3: {inspect.facts.python3.version ?? "—"}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <FactDot ok={inspect.facts.python3Venv.available} /> venv آماده
                  </span>
                  <span className="flex items-center gap-1.5">
                    <FactDot ok={inspect.facts.openssl.present} /> OpenSSL: {inspect.facts.openssl.version ?? "—"}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <FactDot ok={inspect.facts.service.installed} /> سرویس نصب‌شده: {inspect.facts.service.installed ? "بله" : "خیر"}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <FactDot ok={inspect.facts.service.active} /> سرویس فعال: {inspect.facts.service.active ? "بله" : "خیر"}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <FactDot ok={inspect.facts.ufw.available} /> UFW: {inspect.facts.ufw.status ?? "در دسترس نیست"}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Radio className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    درخواست دستگاه دیده‌شده: {inspect.deviceObservations.seenRequests ? "بله" : "خیر"}
                    {inspect.deviceObservations.lastSeen && (
                      <span className="text-muted-foreground">({formatJalaliDateTime(inspect.deviceObservations.lastSeen)})</span>
                    )}
                  </span>
                </div>
              </div>

              <div className="rounded-lg border bg-muted/20 p-3 space-y-1.5 text-xs">
                <div className="font-semibold">اشغال پورت‌ها روی سرور</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
                  {Object.entries(inspect.listeners).map(([key, occ]) => (
                    <span key={key} className="flex items-center gap-1.5">
                      {occ.occupied ? (
                        <X className="size-3.5 shrink-0 text-warning" aria-label="اشغال" />
                      ) : (
                        <Check className="size-3.5 shrink-0 text-success" aria-label="آزاد" />
                      )}
                      {LISTENER_LABELS[key] ?? key}: {occ.occupied ? `اشغال توسط ${occ.byWhom ?? "—"}` : "آزاد"}
                    </span>
                  ))}
                </div>
              </div>

              {inspect.findings.length > 0 && (
                <div className="rounded-lg border bg-muted/20 p-3 space-y-1.5 text-xs">
                  <div className="font-semibold">نکته‌های بررسی</div>
                  <ul className="list-disc ps-5 space-y-1 leading-5">
                    {inspect.findings.map((f, i) => (
                      <li key={i}>{f}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="rounded-lg border border-info/30 bg-info-soft px-3 py-2 text-[11px] leading-5">
                پیشنهاد عملیات: <span className="font-semibold">{MODE_LABELS[inspect.planProposal.mode] ?? inspect.planProposal.mode}</span>
                {inspect.planProposal.reason && <span> — {inspect.planProposal.reason}</span>}
              </div>

              <div className="flex flex-wrap gap-2">
                <Button onClick={() => planM.mutate()} disabled={planM.isPending} className="min-h-11 gap-1.5">
                  {planM.isPending ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <ScrollText className="size-4" aria-hidden />
                  )}
                  تهیه پلن نصب
                </Button>
                <Button variant="outline" onClick={() => setStep(3)} className="min-h-11">
                  بازگشت
                </Button>
              </div>
            </div>
          )}

          {/* ---------------- Step 5: plan approval ---------------- */}
          {step === 5 && plan && (
            <div className="space-y-3">
              <div className="rounded-lg border bg-muted/20 p-3 space-y-2 text-xs leading-5">
                <div className="font-semibold flex items-center gap-1.5">
                  <ScrollText className="size-3.5" aria-hidden />
                  خلاصه پلن (توکن یک‌بارمصرف، حدود ۱۰ دقیقه اعتبار)
                </div>
                <p>{plan.summary}</p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                  <span>عملیات: {MODE_LABELS[plan.plan.mode] ?? plan.plan.mode}</span>
                  <span>میزبان: <span dir="ltr" className="font-mono">{plan.plan.host}</span></span>
                  <span>
                    پورت‌ها:{" "}
                    <span dir="ltr" className="font-mono">
                      {toPersianDigits(plan.plan.ports.deviceListener)}/{toPersianDigits(plan.plan.ports.internalApi)}/
                      {toPersianDigits(plan.plan.ports.httpsApi)}/{toPersianDigits(plan.plan.ports.ssh)}
                    </span>
                  </span>
                  <span>
                    انقضای پلن: {formatJalaliDateTime(new Date(plan.plan.expiresAt))}
                  </span>
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <Checkbox
                  checked={planConfirmed}
                  onCheckedChange={(v) => setPlanConfirmed(v === true)}
                  aria-label="برنامه را تأیید می‌کنم"
                />
                برنامه را تأیید می‌کنم
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => {
                    setStep(6);
                    void startInstall();
                  }}
                  disabled={!planConfirmed || installing}
                  className="min-h-11 gap-1.5"
                >
                  {installing ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <CheckCircle2 className="size-4" aria-hidden />
                  )}
                  شروع نصب
                </Button>
                <Button variant="outline" onClick={() => setStep(4)} disabled={installing} className="min-h-11">
                  بازگشت
                </Button>
              </div>
            </div>
          )}

          {/* ---------------- Step 5b: live install stream ---------------- */}
          {step === 6 && !installResult && (
            <div className="space-y-3">
              <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {installing && <Loader2 className="size-4 animate-spin" aria-hidden />}
                  {installStage ? STAGE_LABELS[installStage] : "در انتظار شروع…"}
                </div>
                {progress && (
                  <>
                    <Progress value={progress.percent} className="h-2" />
                    <div className="text-[11px] text-muted-foreground" dir="ltr">
                      {formatBytes(progress.bytesSent)} / {formatBytes(progress.bytesTotal)} — {toPersianDigits(Math.round(progress.percent))}٪
                    </div>
                  </>
                )}
                {needInspectMsg && (
                  <div className="rounded-md border border-warning/30 bg-warning-soft text-warning text-xs p-2.5 leading-5">
                    {needInspectMsg}
                  </div>
                )}
                {installError && (
                  <div className="rounded-md border border-danger/30 bg-danger-soft text-danger text-xs p-2.5 leading-5 space-y-1">
                    <div className="flex items-start gap-1.5">
                      <AlertTriangle className="size-3.5 mt-0.5 shrink-0" aria-hidden />
                      <span>{installError.message}</span>
                    </div>
                    {installError.uncertain && (
                      <div className="font-semibold">نتیجه نامطمئن است؛ پیش از تلاش مجدد بررسی لازم است.</div>
                    )}
                  </div>
                )}
                <div
                  ref={logBoxRef}
                  className="rounded-md border bg-card max-h-40 overflow-y-auto font-mono text-[10px] leading-4 p-2 space-y-0.5"
                  dir="ltr"
                >
                  {logs.length === 0 ? (
                    <span className="text-muted-foreground">— لاگ نصب —</span>
                  ) : (
                    logs.map((line, i) => (
                      <div key={i} className="break-all whitespace-pre-wrap">
                        {line}
                      </div>
                    ))
                  )}
                </div>
              </div>
              {installError && !installing && (
                <Button variant="outline" onClick={() => setStep(5)} className="min-h-11">
                  بازگشت به تأیید پلن
                </Button>
              )}
            </div>
          )}

          {/* ---------------- Step 6: activation + device-side settings ---------------- */}
          {step === 6 && installResult && (
            <div className="space-y-3">
              <div className="rounded-lg border border-success/30 bg-success-soft px-3 py-2.5 text-xs leading-5 space-y-1">
                <div className="flex items-center gap-1.5 font-semibold text-success">
                  <CheckCircle2 className="size-4" aria-hidden />
                  نصب کامل شد
                </div>
                <div className="text-foreground">
                  شنونده‌ها: {installResult.listenersOk ? "سالم" : "بررسی لازم دارد"} — API:{" "}
                  {installResult.apiOk ? "پاسخ‌گو" : "بررسی لازم دارد"}
                  {installResult.apiUrl && (
                    <>
                      {" "}— آدرس API: <span className="font-mono" dir="ltr">{installResult.apiUrl}</span>
                    </>
                  )}
                </div>
              </div>

              {activated ? (
                <>
                  <div className="rounded-lg border bg-muted/20 p-3 space-y-2 text-xs">
                    <div className="font-semibold flex items-center gap-1.5">
                      <MonitorSmartphone className="size-3.5" aria-hidden />
                      تنظیمات ADMS که باید روی خود دستگاه وارد شود
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
                      <span>
                        سرور (IP): <span className="font-mono" dir="ltr">{plan?.plan.host ?? host}</span>
                      </span>
                      <span>
                        پورت شنونده دستگاه:{" "}
                        <span className="font-mono" dir="ltr">
                          {toPersianDigits(plan?.plan.ports.deviceListener ?? 8081)}
                        </span>
                      </span>
                      <span>
                        سریال دستگاه: <span className="font-mono" dir="ltr">{selectedDevice?.serial ?? "—"}</span>
                      </span>
                      <span>خواندن اسکن‌ها: فعال</span>
                    </div>
                    <div className="rounded-md border border-warning/30 bg-warning-soft px-2.5 py-2 text-warning leading-5">
                      برای تأیید نهایی، یک اسکن واقعی روی دستگاه انجام دهید.
                    </div>
                  </div>
                  <div className="flex justify-start">
                    <Button variant="outline" onClick={() => onOpenChange(false)} className="min-h-11">
                      بستن
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  {activateError && (
                    <div className="rounded-md border border-danger/30 bg-danger-soft text-danger text-xs p-2.5">
                      {activateError}
                    </div>
                  )}
                  <Button
                    onClick={() => activateM.mutate()}
                    disabled={activateM.isPending}
                    className="min-h-11 gap-1.5"
                  >
                    {activateM.isPending ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                    ) : (
                      <Radio className="size-4" aria-hidden />
                    )}
                    فعال‌سازی اتصال
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function WandIcon() {
  return <Wand2 className="size-5 text-primary" aria-hidden />;
}
