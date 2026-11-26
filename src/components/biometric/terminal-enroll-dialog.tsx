"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Fingerprint, Loader2, Radio, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { toPersianDigits } from "@/lib/jalali";
import { cn } from "@/lib/utils";
import type { TerminalDeviceRow } from "@/components/biometric/terminal-devices-panel";

// ============================================================
// ثبت بایومتریک روی ترمینال فیزیکی — confirming an identity that
// was enrolled ON THE DEVICE itself (never a remote template).
//
// Flow: propose terminal user id → operator enrolls the person from
// the terminal's own menu → «انتظار برای اسکن تأیید» opens the live
// SSE stream → the first FRESH matching biometric scan completes the
// link (device serial + terminal user id ↔ importer).
// ============================================================

export interface TerminalEnrollDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  importer: { id: number; name: string; importerCode: string };
}

interface EnrollStartResponse {
  enrollment: {
    enrollmentId: string;
    deviceKey: string;
    terminalUserId: string;
    importerId: number;
    expiresAt: string;
  };
}

interface EnrollIdentity {
  deviceKey: string;
  terminalUserId: string;
  importerId: number;
  method: string;
}

const METHOD_LABELS: Record<string, string> = {
  FINGERPRINT: "اثر انگشت",
  FACE: "چهره",
  PALM: "کف دست",
};

const TERMINAL_USER_ID_RE = /^[1-9][0-9]{0,8}$/;

type Phase = "setup" | "waiting" | "confirming" | "done";

export function TerminalEnrollDialog({ open, onOpenChange, importer }: TerminalEnrollDialogProps) {
  const queryClient = useQueryClient();

  const [phase, setPhase] = React.useState<Phase>("setup");
  const [deviceKey, setDeviceKey] = React.useState<string | null>(null);
  const [terminalUserId, setTerminalUserId] = React.useState("");
  const [userIdTouched, setUserIdTouched] = React.useState(false);
  const [userIdLocked, setUserIdLocked] = React.useState(false);
  const [registrationDevice, setRegistrationDevice] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [statusMessage, setStatusMessage] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [expired, setExpired] = React.useState(false);
  const [enrollment, setEnrollment] = React.useState<EnrollStartResponse["enrollment"] | null>(null);
  const [scanInfo, setScanInfo] = React.useState<{ method: string; deviceTime: string } | null>(null);
  const [identity, setIdentity] = React.useState<EnrollIdentity | null>(null);
  const [secondsLeft, setSecondsLeft] = React.useState<number | null>(null);

  const esRef = React.useRef<EventSource | null>(null);

  const reset = () => {
    setPhase("setup");
    setDeviceKey(null);
    setTerminalUserId("");
    setUserIdTouched(false);
    setUserIdLocked(false);
    setRegistrationDevice(null);
    setError(null);
    setStatusMessage(null);
    setNotice(null);
    setExpired(false);
    setEnrollment(null);
    setScanInfo(null);
    setIdentity(null);
    setSecondsLeft(null);
  };

  const closeStream = () => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  };

  React.useEffect(() => {
    if (open) reset();
    else closeStream();
    return closeStream;
  }, [open]);

  // ---------- eligible devices ----------
  const devicesQ = useQuery({
    queryKey: ["terminal-devices", "terminal-enroll"],
    queryFn: () => apiFetch<{ devices: TerminalDeviceRow[] }>("/api/biometric/terminal/devices"),
    enabled: open,
  });
  const eligibleDevices = (devicesQ.data?.devices ?? []).filter((d) => d.isEnabled);

  // Auto-select the sole eligible device; with several devices the
  // choice is ALWAYS explicit — never a silent arbitrary pick.
  React.useEffect(() => {
    const devs = (devicesQ.data?.devices ?? []).filter((d) => d.isEnabled);
    if (devs.length === 1) {
      setDeviceKey(devs[0].serial);
    } else if (deviceKey && !devs.some((d) => d.serial === deviceKey)) {
      setDeviceKey(null);
    }
  }, [devicesQ.data, deviceKey]);

  // ---------- propose the EXISTING physical terminal user id ----------
  const proposeM = useMutation({
    mutationFn: (serial: string) =>
      apiFetch<{ terminalUserId: string; locked: boolean }>("/api/biometric/terminal/enroll", {
        method: "POST",
        body: JSON.stringify({
          action: "propose-user",
          importerId: importer.id,
          deviceKey: serial,
        }),
      }),
    onSuccess: (res, serial) => {
      if (serial !== deviceKey) return;
      setRegistrationDevice(serial);
      setUserIdLocked(res.locked);
      if (res.locked || !userIdTouched) setTerminalUserId(res.terminalUserId);
    },
    onError: (e: Error) => { setError(e.message); toast.error(e.message); },
  });

  React.useEffect(() => {
    if (open && phase === "setup" && deviceKey && !userIdTouched) {
      proposeM.mutate(deviceKey);
    }
  }, [deviceKey, phase, open]);

  // ---------- countdown to enrollment expiry ----------
  React.useEffect(() => {
    if (!enrollment) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((new Date(enrollment.expiresAt).getTime() - Date.now()) / 1000));
      setSecondsLeft(left);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [enrollment]);

  // ---------- complete the link once the confirm scan arrives ----------
  const completeM = useMutation({
    mutationFn: (input: { enrollmentId: string; scanId: string }) =>
      apiFetch<{ completed: boolean; identity: EnrollIdentity }>("/api/biometric/terminal/enroll", {
        method: "POST",
        body: JSON.stringify({
          action: "complete",
          enrollmentId: input.enrollmentId,
          scanId: input.scanId,
        }),
      }),
    onSuccess: (res) => {
      setIdentity(res.identity);
      setPhase("done");
      closeStream();
      toast.success("پیوند بایومتریک تأیید شد.");
      void queryClient.invalidateQueries({ queryKey: ["importers"] });
    },
    onError: (e: Error) => {
      setError(e.message);
      setPhase("waiting");
    },
  });

  // ---------- start waiting for the confirmation scan ----------
  const startM = useMutation({
    mutationFn: () =>
      apiFetch<EnrollStartResponse>("/api/biometric/terminal/enroll", {
        method: "POST",
        body: JSON.stringify({
          action: "start",
          importerId: importer.id,
          deviceKey: deviceKey ?? "",
          terminalUserId,
        }),
      }),
    onSuccess: (res) => {
      const enr = res.enrollment;
      setEnrollment(enr);
      setExpired(false);
      setError(null);
      setNotice(null);
      setPhase("waiting");

      const es = new EventSource(`/api/biometric/terminal/events?enrollmentId=${encodeURIComponent(enr.enrollmentId)}`);
      esRef.current = es;

      es.addEventListener("status", (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data) as { message?: string };
          setStatusMessage(data.message ?? null);
        } catch {
          // ignore malformed frames
        }
      });

      es.addEventListener("heartbeat", () => {
        // keep-alive — the stream is alive
      });

      es.addEventListener("notice", (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data) as { kind?: string; message?: string };
          if (data.kind === "ENROLLMENT_USER_MISMATCH") {
            setError(data.message ?? "اسکن با شناسه کاربر واردشده مطابقت ندارد؛ دوباره تلاش کنید.");
          } else if (data.message) setNotice(data.message);
        } catch {
          // ignore malformed frames
        }
      });

      es.addEventListener("expired", () => {
        closeStream();
        setExpired(true);
        setPhase("setup");
        setEnrollment(null);
      });

      es.addEventListener("enrollment-scan", (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data) as {
            enrollmentId: string;
            scanId: string;
            method: string;
            deviceTime: string;
          };
          setError(null);
          setNotice(null);
          setScanInfo({ method: data.method, deviceTime: data.deviceTime });
          setPhase("confirming");
          completeM.mutate({ enrollmentId: enr.enrollmentId, scanId: data.scanId });
        } catch {
          // ignore malformed frames
        }
      });

      es.onerror = () => {
        // The browser retries automatically; while disconnected the
        // live dot stays off because status/heartbeat stop arriving.
      };
    },
    onError: (e: Error) => setError(e.message),
  });

  // ---------- cancel ----------
  const cancelM = useMutation({
    mutationFn: () =>
      apiFetch<{ canceled: boolean }>("/api/biometric/terminal/enroll", {
        method: "POST",
        body: JSON.stringify({ action: "cancel", enrollmentId: enrollment?.enrollmentId ?? "" }),
      }),
    onSuccess: () => {
      closeStream();
      setEnrollment(null);
      setPhase("setup");
      toast.info("درخواست انتظار لغو شد.");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // closing the dialog mid-wait cancels the enrollment best-effort
  const requestClose = (v: boolean) => {
    if (!v && enrollment && (phase === "waiting" || phase === "confirming")) {
      void apiFetch("/api/biometric/terminal/enroll", {
        method: "POST",
        body: JSON.stringify({ action: "cancel", enrollmentId: enrollment.enrollmentId }),
      }).catch(() => undefined);
      closeStream();
    }
    onOpenChange(v);
  };

  const canStart =
    phase === "setup" &&
    !!deviceKey &&
    registrationDevice === deviceKey &&
    !proposeM.isPending &&
    TERMINAL_USER_ID_RE.test(terminalUserId) &&
    !startM.isPending;

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent className="sm:max-w-lg" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Fingerprint className="size-5 text-primary" aria-hidden />
            ثبت اثر انگشت، چهره یا کف دست — {importer.name}
          </DialogTitle>
          <DialogDescription>
            نمبر واردکننده: <span dir="ltr" className="font-mono">{importer.importerCode}</span> — ثبت از طریق ترمینال فیزیکی بندر انجام می‌شود.
          </DialogDescription>
        </DialogHeader>

        {phase === "done" && identity ? (
          /* ---------- success panel ---------- */
          <div className="space-y-3">
            <div className="rounded-lg border border-success/30 bg-success-soft px-3 py-3 text-sm">
              <div className="flex items-center gap-2 font-semibold text-success">
                <CheckCircle2 className="size-5" aria-hidden />
                پیوند تأیید شد
              </div>
              <p className="text-xs text-foreground mt-1 leading-5">
                هویت بایومتریک این واردکننده روی دستگاه تأیید شد و با پروفایل سیستم پیوند خورد.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg border bg-muted/20 p-3 text-xs">
              <span className="text-muted-foreground">سریال دستگاه:</span>
              <span className="font-mono" dir="ltr">{identity.deviceKey}</span>
              <span className="text-muted-foreground">شناسه کاربر دستگاه:</span>
              <span className="font-mono" dir="ltr">{toPersianDigits(identity.terminalUserId)}</span>
              <span className="text-muted-foreground">روش اسکن:</span>
              <span>{METHOD_LABELS[identity.method] ?? identity.method}</span>
              <span className="text-muted-foreground">نمبر واردکننده:</span>
              <span className="font-mono" dir="ltr">{importer.importerCode}</span>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {/* device select — always visible */}
            <div className="space-y-1.5">
              <Label htmlFor="tenroll-device">دستگاه ترمینال</Label>
              <Select
                value={deviceKey ?? ""}
                onValueChange={(v) => {
                  setDeviceKey(v);
                  setUserIdTouched(false);
                  setUserIdLocked(false);
                  setRegistrationDevice(null);
                  setTerminalUserId("");
                  setError(null);
                }}
                disabled={phase !== "setup"}
              >
                <SelectTrigger id="tenroll-device">
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
              {eligibleDevices.length === 0 && !devicesQ.isLoading && (
                <p className="text-xs text-warning">
                  هیچ دستگاه ترمینال فعالی یافت نشد — ابتدا در «تنظیمات دستگاه‌های بایومتریک» دستگاه را ثبت و فعال کنید.
                </p>
              )}
            </div>

            {/* terminal user id — always visible, clearly labelled */}
            <div className="space-y-1.5">
              <Label htmlFor="tenroll-user" className="leading-5">
                شناسه کاربر روی دستگاه (شماره واقعی ثبت‌شده در دستگاه)
              </Label>
              <Input
                id="tenroll-user"
                dir="ltr"
                className="text-left font-mono"
                inputMode="numeric"
                value={terminalUserId}
                readOnly={userIdLocked}
                aria-readonly={userIdLocked}
                disabled={phase !== "setup" || proposeM.isPending || registrationDevice !== deviceKey}
                onChange={(e) => {
                  if (userIdLocked) return;
                  setTerminalUserId(e.target.value.replace(/[^0-9]/g, "").slice(0, 9));
                  setUserIdTouched(true);
                }}
                placeholder={proposeM.isPending ? "در حال خواندن از سیستم…" : "مثلاً 1054"}
              />
              <p className="text-[11px] text-muted-foreground leading-5">
                {userIdLocked
                  ? "این شناسه قبلاً ثبت و تأیید شده است و قابل تغییر نیست؛ حتی مدیر سیستم نمی‌تواند آن را تغییر دهد."
                  : "این شماره همان شناسه کاربر واقعی روی دستگاه فیزیکی است (عدد مثبت، حداکثر ۹ رقم). پس از اولین تأیید، برای همیشه ثابت می‌ماند."}
              </p>
            </div>

            {/* instructions */}
            <ol className="rounded-lg border bg-muted/20 px-3 py-2.5 text-xs leading-6 list-decimal ps-5 space-y-0.5">
              <li>کاربر را روی صفحه اصلی دستگاه ثبت کنید.</li>
              <li>اثر بایومتریک او را از منوی خود دستگاه ثبت نمایید.</li>
              <li>سپس «انتظار برای اسکن تأیید» را فشار دهید و فرد روی صفحه اصلی دستگاه تأیید شود.</li>
            </ol>

            {/* waiting state */}
            {(phase === "waiting" || phase === "confirming") && enrollment && (
              <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium flex items-center gap-2">
                    {phase === "confirming" ? (
                      <Loader2 className="size-4 animate-spin text-primary" aria-hidden />
                    ) : (
                      <Radio className="size-4 text-primary animate-pulse" aria-hidden />
                    )}
                    {phase === "confirming" ? "در حال تأیید اسکن…" : (statusMessage ?? "انتظار برای اسکن تأیید…")}
                  </span>
                  {secondsLeft !== null && (
                    <span className={cn("text-xs font-mono", secondsLeft <= 20 ? "text-danger" : "text-muted-foreground")}>
                      {toPersianDigits(secondsLeft)} ثانیه
                    </span>
                  )}
                </div>
                {scanInfo && (
                  <div className="text-xs text-muted-foreground">
                    اسکن دریافت شد: {METHOD_LABELS[scanInfo.method] ?? scanInfo.method} — زمان دستگاه:{" "}
                    <span className="font-mono" dir="ltr">{scanInfo.deviceTime}</span>
                  </div>
                )}
                {notice && <div className="text-xs text-warning leading-5">{notice}</div>}
              </div>
            )}

            {expired && (
              <div className="rounded-md border border-warning/30 bg-warning-soft text-warning text-xs p-2.5 flex items-start gap-1.5">
                <AlertTriangle className="size-3.5 mt-0.5 shrink-0" aria-hidden />
                <span>زمان درخواست پایان یافت — درخواست جدید بدهید.</span>
              </div>
            )}

            {error && (
              <div role="alert" aria-live="polite" className="rounded-md border border-danger/30 bg-danger-soft text-danger text-xs p-2.5 flex items-start gap-1.5">
                <X className="size-3.5 mt-0.5 shrink-0" aria-hidden />
                <span>{error}</span>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="flex-row justify-start gap-2">
          {phase === "done" ? (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              بستن
            </Button>
          ) : (
            <>
              <Button
                onClick={() => startM.mutate()}
                disabled={!canStart}
                className="gap-1.5"
              >
                {startM.isPending ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Fingerprint className="size-4" aria-hidden />
                )}
                انتظار برای اسکن تأیید
              </Button>
              {(phase === "waiting" || phase === "confirming") && (
                <Button variant="outline" disabled={cancelM.isPending} onClick={() => cancelM.mutate()}>
                  {cancelM.isPending ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : null}
                  لغو انتظار
                </Button>
              )}
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={phase === "confirming"}
              >
                {phase === "setup" ? "لغو" : "بستن"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
