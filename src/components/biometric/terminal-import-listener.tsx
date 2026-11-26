"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Fingerprint, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiFetch } from "@/lib/client-api";
import { cn } from "@/lib/utils";
import type { TerminalDeviceRow } from "@/components/biometric/terminal-devices-panel";

// ============================================================
// TerminalImportListener — live scan → create-form bridge for the
// Entries view. While the view is mounted, the tab is visible, the
// user may create entries and NO conflicting dialog is open, it
// holds the exclusive scan lease of the selected terminal and turns
// an on-device biometric identification into openCreate(importerId).
//
// Pause rules (the EventSource is closed, not just muted):
//  • import form open → paused (resumes when it closes)
//  • identification / enrollment / detail dialogs → paused
//  • hidden tab → closed (visibilitychange)
//  • LEASE_BUSY / LEASE_LOST / AUTH_LOST → 60 s cooldown, then retry
// Duplicate identified popups are impossible (one per 3 s max).
// ============================================================

const DEVICE_STORAGE_KEY = "terminal-import-listener-device";
const IDENTIFIED_DEDUPE_MS = 3000;
const UNMAPPED_TOAST_THROTTLE_MS = 30_000;
const LEASE_COOLDOWN_MS = 60_000;

interface TerminalNotice {
  kind?: string;
  message?: string;
  terminalUserId?: string;
}

interface IdentifiedEvent {
  scanId: string;
  deviceKey: string;
  terminalUserId: string;
  method: string;
  deviceTime: string;
  importer: {
    id: number;
    importerCode: string;
    name: string;
    fatherName: string | null;
    companyName: string | null;
    idCardNumber: string | null;
    phone: string | null;
    importerType: string;
    status: string;
    membershipStatus: string;
    biometricStatus: string;
    registeredCheckpointId: number | null;
    photoData: string | null;
  };
}

export function TerminalImportListener({
  active,
  paused = false,
  onIdentified,
}: {
  active: boolean;
  paused?: boolean;
  onIdentified: (importerId: number, importerName: string) => void;
}) {
  // ---------- device registry ----------
  const devicesQ = useQuery({
    queryKey: ["terminal-devices", "import-listener"],
    queryFn: () => apiFetch<{ devices: TerminalDeviceRow[] }>("/api/biometric/terminal/devices"),
    enabled: active,
    staleTime: 30_000,
  });
  const eligibleDevices = React.useMemo(() => {
    const devices = devicesQ.data?.devices ?? [];
    // both transports are eligible — the server resolves the identity
    return devices.filter((d) => d.isEnabled && (d.transport === "LAN" || d.transport === "ADMS_SERVER"));
  }, [devicesQ.data]);

  const [deviceKey, setDeviceKey] = React.useState<string | null>(null);

  // Device selection: auto-select the SOLE eligible device; with several,
  // the last VALID manual choice is remembered in localStorage and is
  // never silently replaced by an unrelated device.
  React.useEffect(() => {
    const serials = eligibleDevices.map((d) => d.serial);
    if (serials.length === 1) {
      setDeviceKey(serials[0]);
    } else if (serials.length > 1) {
      setDeviceKey((cur) => {
        if (cur && serials.includes(cur)) return cur; // keep a valid choice
        try {
          const remembered = localStorage.getItem(DEVICE_STORAGE_KEY);
          if (remembered && serials.includes(remembered)) return remembered;
        } catch {
          // storage unavailable — session-only choice
        }
        return null; // multiple devices, no valid choice → explicit pick
      });
    } else {
      setDeviceKey(null);
    }
  }, [devicesQ.data, eligibleDevices]);

  const selectDevice = (serial: string) => {
    setDeviceKey(serial);
    try {
      localStorage.setItem(DEVICE_STORAGE_KEY, serial);
    } catch {
      // storage unavailable — choice stays session-only
    }
  };

  // ---------- visibility ----------
  const [visible, setVisible] = React.useState(true);
  React.useEffect(() => {
    const onVis = () => {
      // hidden tabs stop consuming scans immediately
      setVisible(document.visibilityState === "visible");
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // ---------- live state + cooldowns ----------
  const [live, setLive] = React.useState(false);
  const [cooling, setCooling] = React.useState(false);
  const cooldownTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastIdentifiedRef = React.useRef(0);
  const lastUnmappedRef = React.useRef(0);
  const onIdentifiedRef = React.useRef(onIdentified);
  React.useEffect(() => {
    onIdentifiedRef.current = onIdentified;
  });

  React.useEffect(() => () => {
    if (cooldownTimerRef.current) clearTimeout(cooldownTimerRef.current);
  }, []);

  // ---------- the SSE stream ----------
  React.useEffect(() => {
    if (!active || paused || !visible || cooling || !deviceKey) {
      setLive(false);
      return;
    }

    const es = new EventSource(`/api/biometric/terminal/events?deviceKey=${encodeURIComponent(deviceKey)}`);

    es.addEventListener("status", () => setLive(true));
    es.addEventListener("heartbeat", () => setLive(true));

    es.addEventListener("identified", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as IdentifiedEvent;
        const now = Date.now();
        if (now - lastIdentifiedRef.current < IDENTIFIED_DEDUPE_MS) return;
        lastIdentifiedRef.current = now;
        setLive(true);
        toast.success(`شناسایی شد: ${data.importer.name} — فرم واردات آماده است.`);
        onIdentifiedRef.current(data.importer.id, data.importer.name);
      } catch {
        // ignore malformed frames
      }
    });

    es.addEventListener("notice", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as TerminalNotice;
        setLive(true);
        if (data.kind === "UNMAPPED_SCAN") {
          const now = Date.now();
          if (now - lastUnmappedRef.current < UNMAPPED_TOAST_THROTTLE_MS) return;
          lastUnmappedRef.current = now;
          const id = data.terminalUserId ? ` (شناسه کاربر ${data.terminalUserId})` : "";
          toast.info(`اسکن شناسایی‌نشده${id}`, {
            description: data.message ?? undefined,
            duration: 4000,
          });
          return;
        }
        if (data.kind === "LEASE_BUSY" || data.kind === "LEASE_LOST" || data.kind === "AUTH_LOST") {
          // warn once, stop consuming for 60 s, then retry
          toast.warning(data.message ?? "دستگاه ترمینال در جای دیگر در حال استفاده است.");
          setLive(false);
          if (cooldownTimerRef.current) clearTimeout(cooldownTimerRef.current);
          cooldownTimerRef.current = setTimeout(() => setCooling(false), LEASE_COOLDOWN_MS);
          setCooling(true);
        }
      } catch {
        // ignore malformed frames
      }
    });

    es.onerror = () => {
      // The browser auto-reconnects; the dot shows the honest state.
      setLive(false);
    };

    return () => {
      es.close();
    };
  }, [active, paused, visible, cooling, deviceKey]);

  // ---------- tiny toolbar selector (renders inside the toolbar area) ----------
  if (!active) return null;

  // No terminal registered (or none enabled on this port) — a CONCISE
  // setup-required notice instead of a silently absent control. The
  // full registry lives in «تنظیمات دستگاه‌های بایومتریک».
  if (devicesQ.isLoading) {
    return (
      <div
        className="flex items-center gap-1.5 rounded-lg border border-dashed bg-muted/30 px-2 py-1 text-xs text-muted-foreground"
        title="بررسی وضعیت ترمینال‌های بایومتریک…"
      >
        <Fingerprint className="size-3.5 animate-pulse" aria-hidden />
        <span className="whitespace-nowrap">در حال بررسی ترمینال…</span>
      </div>
    );
  }
  if (devicesQ.isError) {
    // A failed registry read is NOT the same as "no terminal" — never
    // show an empty/setup state for a load failure.
    return (
      <button
        type="button"
        onClick={() => void devicesQ.refetch()}
        className="flex items-center gap-1.5 rounded-lg border border-dashed border-danger/40 bg-danger-soft px-2 py-1 text-xs text-danger min-h-9"
        title={`خواندن فهرست دستگاه‌ها ناموفق بود — ${devicesQ.error instanceof Error ? devicesQ.error.message : "خطای نامشخص"} (برای تلاش دوباره کلیک کنید)`}
      >
        <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
        <span className="whitespace-nowrap">خطا در خواندن دستگاه‌ها — تلاش دوباره</span>
      </button>
    );
  }
  if (eligibleDevices.length === 0) {
    return (
      <div
        className="flex items-center gap-1.5 rounded-lg border border-dashed border-warning/40 bg-warning-soft px-2 py-1 text-xs text-warning"
        title="هیچ ترمینال بایومتریکی ثبت یا فعال نیست — از «مدیریت سیستم → تنظیمات دستگاه‌های بایومتریک» ترمینال فیزیکی را ثبت کنید."
      >
        <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
        <span className="whitespace-nowrap">ترمینال بایومتریک ثبت نشده — تنظیمات لازم است</span>
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-1.5 rounded-lg border border-dashed bg-muted/30 ps-2 pe-1 py-1"
      title="شناسایی زنده با ترمینال بایومتریک — اسکن روی دستگاه، فرم واردات را آماده می‌کند"
    >
      <Fingerprint
        className={cn("size-3.5 shrink-0", live ? "text-success" : "text-muted-foreground")}
        aria-hidden
      />
      {eligibleDevices.length === 1 ? (
        <span className="text-xs text-muted-foreground whitespace-nowrap max-w-36 truncate">
          {eligibleDevices[0].name}
        </span>
      ) : (
        <Select value={deviceKey ?? ""} onValueChange={selectDevice}>
          <SelectTrigger
            aria-label="دستگاه شناسایی زنده"
            className="h-7 w-auto gap-1 border-none bg-transparent text-xs shadow-none px-1"
          >
            <SelectValue placeholder="دستگاه…" />
          </SelectTrigger>
          <SelectContent className="max-h-56">
            {eligibleDevices.map((d) => (
              <SelectItem key={d.serial} value={d.serial}>
                {d.name} — <span dir="ltr" className="font-mono">{d.serial}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Badge
        variant="outline"
        className={cn(
          "text-[9px] px-1.5 py-0 whitespace-nowrap",
          cooling
            ? "bg-warning-soft text-warning border-warning/30"
            : live
              ? "bg-success-soft text-success border-success/30"
              : "bg-muted text-muted-foreground border-border"
        )}
      >
        {cooling ? "توقف موقت" : live ? "زنده" : "آماده"}
      </Badge>
      <span
        className={cn(
          "inline-block size-2 shrink-0 rounded-full",
          live ? "bg-success animate-pulse" : cooling ? "bg-warning" : "bg-muted-foreground/40"
        )}
        role="img"
        aria-label={live ? "اتصال زنده فعال" : "اتصال زنده غیرفعال"}
      />
    </div>
  );
}
