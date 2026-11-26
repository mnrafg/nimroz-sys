"use client";

import * as React from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Activity,
  Check,
  Fingerprint,
  Info,
  Loader2,
  Network,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Server,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SearchSelect, toOptions } from "@/components/ui/search-select";
import {
  EmptyState,
  FieldError,
  FormDialog,
  FormSection,
  SortHead,
  TablePagination,
  TableShell,
  TableSkeleton,
  TableToolbar,
  usePagedRows,
  useSortedRows,
} from "@/components/shared";
import { apiFetch } from "@/lib/client-api";
import { formatJalaliDateTime, toPersianDigits } from "@/lib/jalali";
import { cn } from "@/lib/utils";

// ============================================================
// تنظیمات دستگاه‌های بایومتریک — panel for terminal (uFace-class)
// devices connected DIRECTLY (LAN) or through the shared ADMS
// server. Distinct from the legacy «مدیریت دستگاه‌ها» (gateway /
// bridge) page: transports here are LAN and ADMS_SERVER only.
//
// Honesty rules reproduced in the UI:
//  • reaching a TCP port or an API health check is NOT the same as
//    protocol authentication or the terminal being online
//  • for ADMS registration the terminal is identified by its SERIAL —
//    a device-side network address is never requested
// ============================================================

export type TerminalTransport = "LAN" | "ADMS_SERVER";

export interface TerminalDeviceRow {
  id: number;
  serial: string;
  name: string;
  transport: TerminalTransport;
  host: string | null;
  port: number | null;
  checkpointId: number;
  checkpoint: { id: number; name: string };
  isEnabled: boolean;
  timezoneOffsetMinutes: number;
  lastSeenAt: string | null;
  model: string | null;
  allowedNetworks: string | null;
  commKeySet: boolean;
  createdAt: string;
  updatedAt: string;
}

interface TerminalStatusResponse {
  device: {
    serial: string;
    transport: string;
    isEnabled: boolean;
    lastSeenAt: string | null;
    model: string | null;
  };
  connection: { completedStage?: string | null; stage: string; stageError: string | null; detail: string | null };
  adms?: {
    configured: boolean;
    readingEnabled: boolean;
    serverReachable?: boolean;
    apiHttpStatus?: number | null;
    apiReachable?: boolean;
    deviceOnline?: boolean;
    deviceLastSeen?: string | null;
    note?: string | null;
    feed?: {
      running: boolean;
      baseline: boolean;
      lastError: string | null;
      lastPollAt: number | null;
    };
  };
}

interface AdmsServerSettingsResponse {
  settings: { protocol: string; host: string; port: number; readEnabled: boolean };
  serverUrl: string | null;
  apiUrl: string | null;
  hasApiToken: boolean;
  tokenTransportAllowed: boolean;
  envManaged: { serverUrl: boolean; readEnabled: boolean; apiUrl: boolean; apiToken: boolean };
}

const TRANSPORT_LABELS: Record<TerminalTransport, string> = {
  LAN: "شبکه محلی",
  ADMS_SERVER: "سرور ADMS",
};

const TRANSPORT_BADGE: Record<TerminalTransport, string> = {
  LAN: "bg-secondary text-primary border-primary/30",
  ADMS_SERVER: "bg-warning-soft text-warning border-warning/30",
};

/** Stage ladder — each line lights up only when the reported stage
 *  has PROVEN at least that far. TCP reachability alone proves nothing. */
const STAGE_LADDER: { stage: string; label: string }[] = [
  { stage: "CONNECTED", label: "اتصال شبکه" },
  { stage: "AUTHENTICATED", label: "احراز هویت پروتکل" },
  { stage: "SERIAL_VERIFIED", label: "تطبیق سریال" },
  { stage: "SUBSCRIBED", label: "اشتراک رویدادهای زنده" },
];

const STAGE_RANK: Record<string, number> = {
  DISCONNECTED: 0,
  CONNECTING: 0,
  CONNECTED: 1,
  AUTHENTICATED: 2,
  SERIAL_VERIFIED: 3,
  SUBSCRIBED: 4,
  FAILED: 0,
};

/** Labeled form field wrapper (same pattern as the importers form). */
function FieldBlock({
  label,
  htmlFor,
  required,
  error,
  hint,
  span,
  children,
}: {
  label: string;
  htmlFor?: string;
  required?: boolean;
  error?: string;
  hint?: string;
  span?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5 min-w-0", span && "sm:col-span-2")}>
      <Label htmlFor={htmlFor}>
        {label}
        {required && <span className="text-danger"> *</span>}
      </Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground leading-4">{hint}</p>}
      {error && <FieldError message={error} />}
    </div>
  );
}

// ============================================================
// Main panel
// ============================================================

export function TerminalDevicesPanel() {
  const queryClient = useQueryClient();

  const [q, setQ] = React.useState("");
  const [debouncedQ, setDebouncedQ] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const [checkpointFilter, setCheckpointFilter] = React.useState<string | null>(null);

  const checkpointsQ = useQuery({
    queryKey: ["checkpoints", "terminal-device-options"],
    queryFn: () =>
      apiFetch<{ checkpoints: { id: number; name: string; province: string; status: string }[] }>(
        "/api/checkpoints"
      ),
    staleTime: 60_000,
  });

  const devices = useQuery({
    placeholderData: keepPreviousData,
    queryKey: ["terminal-devices", checkpointFilter, debouncedQ],
    queryFn: () => {
      const params = new URLSearchParams();
      if (checkpointFilter) params.set("checkpointId", checkpointFilter);
      if (debouncedQ.trim()) params.set("q", debouncedQ.trim());
      return apiFetch<{ devices: TerminalDeviceRow[] }>(
        `/api/biometric/terminal/devices?${params.toString()}`
      );
    },
  });

  const allDevices = devices.data?.devices ?? [];
  const sorter = useSortedRows<TerminalDeviceRow>(
    allDevices,
    React.useMemo(
      () => ({
        name: (r) => r.name,
        port: (r) => r.checkpoint.name,
        lastSeen: (r) => r.lastSeenAt ?? "",
      }),
      []
    )
  );
  const paging = usePagedRows(sorter.sorted, 15);

  // ---------- enable / disable (application-level only) ----------
  const toggle = useMutation({
    mutationFn: (row: TerminalDeviceRow) =>
      apiFetch<{ device: TerminalDeviceRow }>("/api/biometric/terminal/devices", {
        method: "PUT",
        body: JSON.stringify({ id: row.id, isEnabled: !row.isEnabled }),
      }),
    onSuccess: (_data, row) => {
      toast.success(
        row.isEnabled
          ? "دستگاه غیرفعال شد — رویدادهای زنده آن پذیرفته نمی‌شود."
          : "دستگاه فعال شد."
      );
      void queryClient.invalidateQueries({ queryKey: ["terminal-devices"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ---------- create / edit form ----------
  const [formOpen, setFormOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<TerminalDeviceRow | null>(null);
  const [name, setName] = React.useState("");
  const [transport, setTransport] = React.useState<TerminalTransport>("LAN");
  const [serial, setSerial] = React.useState("");
  const [fCheckpointId, setFCheckpointId] = React.useState<string | null>(null);
  const [host, setHost] = React.useState("");
  const [port, setPort] = React.useState("4370");
  const [tzOffset, setTzOffset] = React.useState("270");
  const [commKey, setCommKey] = React.useState("");
  const [allowedNetworks, setAllowedNetworks] = React.useState("");
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string | undefined>>({});

  const clearError = (key: string) =>
    setErrors((prev) => ({ ...prev, [key]: undefined }));

  // Shared ADMS destination — shown for ADMS_SERVER rows in the table
  // and as the in-dialog info box when registering/editing a device.
  const admsSettingsQ = useQuery({
    queryKey: ["terminal-adms-settings"],
    queryFn: () => apiFetch<AdmsServerSettingsResponse>("/api/biometric/terminal/adms-server"),
    staleTime: 15_000,
  });

  const checkpointOptions = toOptions(
    checkpointsQ.data?.checkpoints,
    (c) => c.id,
    (c) => c.name,
    (c) => c.province
  );

  // Auto-select the checkpoint ONLY when exactly one exists —
  // a remembered/valid choice is never overwritten.
  React.useEffect(() => {
    if (!formOpen || editing) return;
    const cps = checkpointsQ.data?.checkpoints ?? [];
    if (!fCheckpointId && cps.length === 1) setFCheckpointId(String(cps[0].id));
  }, [formOpen, editing, checkpointsQ.data, fCheckpointId]);

  const openCreate = () => {
    setEditing(null);
    setName("");
    setTransport("LAN");
    setSerial("");
    setFCheckpointId(null);
    setHost("");
    setPort("4370");
    setTzOffset("270");
    setCommKey("");
    setAllowedNetworks("");
    setAdvancedOpen(false);
    setErrors({});
    setFormOpen(true);
  };

  const openEdit = (row: TerminalDeviceRow) => {
    setEditing(row);
    setName(row.name);
    setTransport(row.transport);
    setSerial(row.serial); // immutable on edit — input stays disabled
    setFCheckpointId(String(row.checkpoint.id));
    setHost(row.host ?? "");
    setPort(row.port ? String(row.port) : "4370");
    setTzOffset(String(row.timezoneOffsetMinutes ?? 270));
    setCommKey(""); // never display or prefill a stored key
    setAllowedNetworks(row.allowedNetworks ?? "");
    setAdvancedOpen(false);
    setErrors({});
    setFormOpen(true);
  };

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        name: name.trim(),
        transport,
        serial: serial.trim(),
        checkpointId: Number(fCheckpointId),
      };
      if (transport === "LAN") {
        body.host = host.trim();
        body.port = Number(port || 4370);
      } else {
        // ADMS: the terminal is identified by its serial on the server —
        // no device-side network address is ever sent.
        body.host = null;
        body.port = null;
      }
      const tz = Number(tzOffset || 270);
      if (Number.isInteger(tz)) body.timezoneOffsetMinutes = tz;
      if (allowedNetworks.trim()) body.allowedNetworks = allowedNetworks.trim();
      else body.allowedNetworks = null;
      if (commKey.trim()) body.commKey = commKey.trim();
      return editing
        ? apiFetch<{ device: TerminalDeviceRow }>("/api/biometric/terminal/devices", {
            method: "PATCH",
            body: JSON.stringify({ ...body, id: editing.id }),
          })
        : apiFetch<{ device: TerminalDeviceRow }>("/api/biometric/terminal/devices", {
            method: "POST",
            body: JSON.stringify(body),
          });
    },
    onSuccess: () => {
      toast.success(editing ? "دستگاه به‌روز شد." : "دستگاه ثبت شد.");
      void queryClient.invalidateQueries({ queryKey: ["terminal-devices"] });
      void queryClient.invalidateQueries({ queryKey: ["terminal-adms-settings"] });
      setFormOpen(false);
      setEditing(null);
    },
    onError: (e: Error) => {
      // Server Dari duplicate/serial hints surface verbatim.
      toast.error(e.message);
    },
  });

  const submit = () => {
    const next: Record<string, string | undefined> = {};
    if (name.trim().length < 2) next.name = "نام دستگاه باید حداقل ۲ حرف باشد.";
    if (!/^[A-Za-z0-9._:-]{4,64}$/.test(serial.trim()))
      next.serial = "شماره سریال باید ۴ تا ۶۴ کاراکتر (حروف، عدد، نقطه، خط تیره) باشد.";
    if (!fCheckpointId) next.checkpointId = "لطفاً بندر را انتخاب کنید.";
    if (transport === "LAN") {
      if (host.trim().length < 3) next.host = "لطفاً آدرس IP یا نام میزبان دستگاه را بنویسید.";
      const p = Number(port);
      if (!port || !Number.isInteger(p) || p < 1 || p > 65535)
        next.port = "پورت باید عددی بین ۱ تا ۶۵۵۳۵ باشد.";
    }
    const tz = Number(tzOffset || 270);
    if (!tzOffset || !Number.isInteger(tz) || tz < -720 || tz > 840)
      next.tzOffset = "اختلاف ساعت باید عددی بین -۷۲۰ تا ۸۴۰ دقیقه باشد.";
    if (commKey.trim() && !/^\d{1,10}$/.test(commKey.trim()))
      next.commKey = "کلید ارتباط فقط عدد است (حداکثر ۱۰ رقم).";
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    save.mutate();
  };

  // ---------- status dialog ----------
  const [statusTarget, setStatusTarget] = React.useState<TerminalDeviceRow | null>(null);

  return (
    <div>
      {/* toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2 no-print">
        <TableToolbar value={q} onChange={setQ} placeholder="جستجو بر اساس نام یا سریال…">
          <SearchSelect
            value={checkpointFilter}
            onChange={setCheckpointFilter}
            options={checkpointOptions}
            placeholder="همه بنادر"
            searchPlaceholder="جستجوی بندر…"
            loading={checkpointsQ.isLoading}
            allowClear
            className="sm:w-44"
          />
        </TableToolbar>
        <Button onClick={openCreate} className="min-h-11 gap-1.5">
          <Plus className="size-4" aria-hidden />
          دستگاه جدید
        </Button>
      </div>

      <TableShell
        footer={
          <TablePagination
            page={paging.page}
            pageCount={paging.pageCount}
            total={paging.total}
            onPage={paging.setPage}
            entityLabel="دستگاه"
          />
        }
      >
        {devices.isLoading ? (
          <TableSkeleton rows={6} cols={8} />
        ) : allDevices.length === 0 ? (
          <EmptyState
            icon={<Fingerprint className="size-8" />}
            title="دستگاه ترمینالی ثبت نشده است"
            description="ترمینال بایومتریک را از طریق شبکه محلی یا سرور ADMS ثبت کنید تا اسکن‌های روی دستگاه به سیستم پیوند بخورند."
            action={
              <Button onClick={openCreate} className="min-h-11 gap-1.5">
                <Plus className="size-4" aria-hidden />
                دستگاه جدید
              </Button>
            }
          />
        ) : (
          <Table className="min-w-[900px]">
            <TableHeader>
              <TableRow>
                <SortHead label="نام" k="name" sort={sorter.sort} onSort={sorter.toggleSort} />
                <TableHead>سریال فیزیکی</TableHead>
                <TableHead>روش اتصال</TableHead>
                <TableHead>آدرس اتصال</TableHead>
                <SortHead label="بندر" k="port" sort={sorter.sort} onSort={sorter.toggleSort} />
                <SortHead label="آخرین ارتباط" k="lastSeen" sort={sorter.sort} onSort={sorter.toggleSort} />
                <TableHead>وضعیت</TableHead>
                <TableHead className="text-center">عملیات</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paging.paged.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <span className="block text-sm font-medium">{row.name}</span>
                    {row.model && (
                      <span className="block text-[10px] text-muted-foreground" dir="ltr">
                        {row.model}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="font-mono text-xs" dir="ltr">
                      {row.serial}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={cn("font-medium whitespace-nowrap text-[11px]", TRANSPORT_BADGE[row.transport])}
                    >
                      {row.transport === "LAN" ? (
                        <Network className="size-3" aria-hidden />
                      ) : (
                        <Server className="size-3" aria-hidden />
                      )}
                      {TRANSPORT_LABELS[row.transport]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm whitespace-nowrap">
                    {row.transport === "LAN" ? (
                      <span className="font-mono text-xs" dir="ltr">
                        {row.host}:{toPersianDigits(row.port ?? "—")}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        سرور ADMS مشترک
                        {admsSettingsQ.data?.serverUrl ? (
                          <span className="block font-mono text-[10px]" dir="ltr">
                            {admsSettingsQ.data.serverUrl}
                          </span>
                        ) : null}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm whitespace-nowrap">{row.checkpoint.name}</TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    {row.lastSeenAt ? formatJalaliDateTime(row.lastSeenAt) : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={cn(
                        "font-medium whitespace-nowrap",
                        row.isEnabled
                          ? "bg-success-soft text-success border-success/30"
                          : "bg-muted text-muted-foreground border-border"
                      )}
                    >
                      {row.isEnabled ? "فعال" : "غیرفعال"}
                    </Badge>
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="min-h-9 gap-1"
                        onClick={() => openEdit(row)}
                        title="ویرایش"
                      >
                        <Pencil className="size-3.5" aria-hidden />
                        <span className="hidden xl:inline">ویرایش</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="min-h-9 gap-1"
                        onClick={() => setStatusTarget(row)}
                        title="گزارش اتصال مرحله‌به‌مرحله"
                      >
                        <Activity className="size-3.5 text-primary" aria-hidden />
                        <span className="hidden xl:inline">وضعیت</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="min-h-9 gap-1"
                        disabled={toggle.isPending}
                        onClick={() => toggle.mutate(row)}
                        title={row.isEnabled ? "غیرفعال‌سازی در سیستم" : "فعال‌سازی در سیستم"}
                      >
                        <Power
                          className={cn("size-3.5", row.isEnabled ? "text-danger" : "text-success")}
                          aria-hidden
                        />
                        <span className="hidden xl:inline">{row.isEnabled ? "غیرفعال" : "فعال"}</span>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </TableShell>

      {/* ---------- create / edit dialog ---------- */}
      <FormDialog
        open={formOpen}
        onOpenChange={(v) => {
          setFormOpen(v);
          if (!v) setEditing(null);
        }}
        title={editing ? "ویرایش دستگاه ترمینال" : "دستگاه ترمینال جدید"}
        description={
          editing
            ? "شماره سریال پس از ثبت تغییر نمی‌کند؛ سایر مقادیر قابل ویرایش است."
            : "ترمینال بایومتریک را از طریق شبکه محلی یا سرور ADMS به سیستم پیوند دهید."
        }
        size="lg"
        busy={save.isPending}
        onSubmit={() => submit()}
        submitLabel="ذخیره"
      >
        <FormSection title="معلومات پایه">
          <FieldBlock label="نام دستگاه" htmlFor="td-name" required error={errors.name}>
            <Input
              id="td-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                clearError("name");
              }}
              placeholder="مثلاً ترمینال ورودی نیمروز"
            />
          </FieldBlock>
          <FieldBlock label="روش اتصال" htmlFor="td-transport" required>
            <Select
              value={transport}
              onValueChange={(v) => {
                setTransport(v as TerminalTransport);
                clearError("host");
                clearError("port");
              }}
            >
              <SelectTrigger id="td-transport">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="LAN">شبکه محلی</SelectItem>
                <SelectItem value="ADMS_SERVER">سرور ADMS</SelectItem>
              </SelectContent>
            </Select>
          </FieldBlock>
          <FieldBlock
            label="شماره سریال فیزیکی"
            htmlFor="td-serial"
            required
            error={errors.serial}
            hint={
              editing
                ? "شماره سریال پس از ثبت دستگاه قابل تغییر نیست."
                : "همان سریالی که دستگاه در منوی سیستم / ADMS گزارش می‌کند."
            }
          >
            <Input
              id="td-serial"
              dir="ltr"
              className="text-left font-mono"
              value={serial}
              disabled={editing !== null}
              onChange={(e) => {
                setSerial(e.target.value.toUpperCase());
                clearError("serial");
              }}
              placeholder="مثلاً CK1234567890"
            />
          </FieldBlock>
          <FieldBlock label="بندر" htmlFor="td-checkpoint" required error={errors.checkpointId}>
            <SearchSelect
              id="td-checkpoint"
              value={fCheckpointId}
              onChange={(v) => {
                setFCheckpointId(v);
                clearError("checkpointId");
              }}
              options={checkpointOptions}
              placeholder="انتخاب بندر"
              searchPlaceholder="جستجوی بندر…"
              loading={checkpointsQ.isLoading}
            />
          </FieldBlock>
        </FormSection>

        {transport === "LAN" ? (
          <FormSection title="اتصال شبکه محلی" description="دستگاه مستقیماً از طریق آدرس شبکه در دسترس است.">
            <FieldBlock
              label="آدرس IP یا نام میزبان"
              htmlFor="td-host"
              required
              error={errors.host}
            >
              <Input
                id="td-host"
                dir="ltr"
                className="text-left font-mono"
                value={host}
                onChange={(e) => {
                  setHost(e.target.value);
                  clearError("host");
                }}
                placeholder="192.168.1.168"
              />
            </FieldBlock>
            <FieldBlock
              label="پورت TCP"
              htmlFor="td-port"
              required
              error={errors.port}
              hint="پورت پیش‌فرض دستگاه‌های ZKTeco برابر ۴۳۷۰ است."
            >
              <Input
                id="td-port"
                dir="ltr"
                className="text-left font-mono"
                inputMode="numeric"
                value={port}
                onChange={(e) => {
                  setPort(e.target.value.replace(/[^0-9]/g, ""));
                  clearError("port");
                }}
                placeholder="4370"
              />
            </FieldBlock>
          </FormSection>
        ) : (
          <div className="space-y-2 sm:col-span-2">
            <div className="rounded-lg border border-info/30 bg-info-soft px-3 py-2.5 text-xs leading-5">
              <div className="font-semibold flex items-center gap-1.5 mb-1">
                <Server className="size-3.5" aria-hidden />
                مقصد مشترک ADMS
              </div>
              {admsSettingsQ.isLoading ? (
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" aria-hidden /> در حال خواندن تنظیمات…
                </span>
              ) : admsSettingsQ.data?.serverUrl ? (
                <>
                  <span className="font-mono text-[11px]" dir="ltr">
                    {admsSettingsQ.data.serverUrl}
                  </span>
                  <span className="block mt-0.5 text-muted-foreground">
                    خواندن اسکن‌های جدید: {admsSettingsQ.data.settings.readEnabled ? "فعال" : "غیرفعال"}
                  </span>
                </>
              ) : (
                <span className="text-warning">
                  اتصال مشترک ADMS در بک‌اند موجود نیست؛ مسئول سیستم باید تنظیمات یک‌باره اتصال را بررسی کند.
                </span>
              )}
            </div>
            <div className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-[11px] leading-5 text-foreground">
              این دستگاه با شماره سریال از سرور ADMS موجود خوانده می‌شود. اتصال ذخیره‌شده خودکار استفاده می‌شود؛ نیازی به تنظیم دوباره سرور در این فرم نیست.
            </div>
          </div>
        )}

        {/* advanced — optional connection hardening */}
        <div className="sm:col-span-2">
          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger asChild>
              <Button type="button" variant="outline" size="sm" className="min-h-9 gap-1.5">
                <Info className="size-3.5" aria-hidden />
                تنظیمات پیشرفته (اختیاری)
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 pt-3">
                <FieldBlock
                  label="اختلاف ساعت دستگاه"
                  htmlFor="td-tz"
                  error={errors.tzOffset}
                  hint="دقیقه نسبت به UTC — کابل (UTC+۴:۳۰) برابر ۲۷۰ است. ساعت درست دستگاه برای پذیرش اسکن‌های تازه ضروری است."
                >
                  <Input
                    id="td-tz"
                    dir="ltr"
                    className="text-left font-mono"
                    inputMode="numeric"
                    value={tzOffset}
                    onChange={(e) => {
                      setTzOffset(e.target.value.replace(/[^0-9-]/g, ""));
                      clearError("tzOffset");
                    }}
                  />
                </FieldBlock>
                <FieldBlock
                  label="کلید ارتباط دستگاه"
                  htmlFor="td-commkey"
                  error={errors.commKey}
                  hint={
                    editing?.commKeySet
                      ? "کلید روی دستگاه ذخیره شده است — برای تغییر، کلید جدید را وارد کنید."
                      : "در صورت فعال بودن کلید روی دستگاه، همان عدد را وارد کنید."
                  }
                >
                  <Input
                    id="td-commkey"
                    type="password"
                    dir="ltr"
                    className="text-left font-mono"
                    inputMode="numeric"
                    autoComplete="new-password"
                    value={commKey}
                    onChange={(e) => {
                      setCommKey(e.target.value.replace(/[^0-9]/g, ""));
                      clearError("commKey");
                    }}
                    placeholder={editing?.commKeySet ? "کلید ذخیره شده است" : "بدون کلید"}
                  />
                </FieldBlock>
                <FieldBlock
                  label="شبکه‌های مجاز"
                  htmlFor="td-networks"
                  span
                  hint="اختیاری — فهرست CIDR جدا‌شده با کاما (مثلاً 192.168.1.0/24، 10.0.0.0/8). خالی یعنی بدون محدودیت شبکه."
                >
                  <Input
                    id="td-networks"
                    dir="ltr"
                    className="text-left font-mono text-xs"
                    value={allowedNetworks}
                    onChange={(e) => setAllowedNetworks(e.target.value)}
                    placeholder="192.168.1.0/24, 10.0.0.0/8"
                  />
                </FieldBlock>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>
      </FormDialog>

      {/* ---------- staged connection report ---------- */}
      <TerminalDeviceStatusDialog
        device={statusTarget}
        open={statusTarget !== null}
        onOpenChange={(v) => !v && setStatusTarget(null)}
      />
    </div>
  );
}

// ============================================================
// Staged connection report — SEPARATE lines per stage with the
// standing honesty note. Auto-refreshes every 10 s while open.
// ============================================================

function TerminalDeviceStatusDialog({
  device,
  open,
  onOpenChange,
}: {
  device: TerminalDeviceRow | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const serial = device?.serial ?? "";
  const statusQ = useQuery({
    queryKey: ["terminal-device-status", serial],
    queryFn: () =>
      apiFetch<TerminalStatusResponse>(
        `/api/biometric/terminal/status?deviceKey=${encodeURIComponent(serial)}`
      ),
    enabled: open && serial.length > 0,
    refetchInterval: 10_000,
  });

  const conn = statusQ.data?.connection;
  const adms = statusQ.data?.adms;
  const rank = conn ? (STAGE_RANK[conn.completedStage ?? conn.stage] ?? 0) : 0;
  const failed = conn?.stage === "FAILED" || conn?.stage === "DISCONNECTED";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Activity className="size-5 text-primary" />
            گزارش اتصال — {device?.name}
          </DialogTitle>
          <DialogDescription>
            سریال <span className="font-mono" dir="ltr">{device?.serial}</span> — بررسی هر مرحله به‌صورت جداگانه گزارش می‌شود.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {statusQ.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-3">
              <Loader2 className="size-4 animate-spin" aria-hidden /> در حال دریافت وضعیت…
            </div>
          ) : statusQ.isError ? (
            <div className="rounded-md border border-danger/30 bg-danger-soft text-danger text-xs p-2.5 space-y-2">
              <div>{(statusQ.error as Error).message}</div>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1"
                disabled={statusQ.isFetching}
                onClick={() => void statusQ.refetch()}
              >
                <RefreshCw className={cn("size-3", statusQ.isFetching && "animate-spin")} aria-hidden />
                تلاش دوباره
              </Button>
            </div>
          ) : (
            <>
              {/* staged ladder — LAN and ADMS paths both report these */}
              {device?.transport === "LAN" && <ul className="space-y-1.5">
                {STAGE_LADDER.map((s, i) => {
                  const failedIndex = Math.min(rank, STAGE_LADDER.length - 1);
                  const ok = rank >= i + 1 && !(failed && i >= failedIndex);
                  const stepFailed = failed && i === failedIndex;
                  return (
                    <li key={s.stage} className="flex items-start gap-2 text-sm">
                      {ok ? (
                        <Check className="mt-0.5 size-4 shrink-0 text-success" aria-label="موفق" />
                      ) : (
                        stepFailed ? <X className="mt-0.5 size-4 shrink-0 text-danger" aria-label="ناموفق" />
                        : <span className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="بررسی نشده">—</span>
                      )}
                      <span className="min-w-0">
                        <span className="font-medium">{s.label}</span>
                        {stepFailed && conn?.stageError && (
                          <span className="block text-xs text-muted-foreground break-words">{conn.stageError}</span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>}
              {conn?.detail && (
                <div className="text-xs text-muted-foreground leading-5" dir="ltr">
                  {conn.detail}
                </div>
              )}

              {/* ADMS-only honest telemetry */}
              {device?.transport === "ADMS_SERVER" && adms && (
                <div className="rounded-lg border bg-muted/30 p-3 space-y-1.5 text-xs">
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                    <span className="text-muted-foreground">دسترسی شبکه به سرور:</span>
                    <span className={adms.serverReachable ? "text-success font-medium" : "text-danger font-medium"}>
                      {adms.serverReachable ? "برقرار" : "ناموفق"}
                    </span>
                    <span className="text-muted-foreground">API خواندن دستگاه:</span>
                    <span className={adms.apiReachable ? "text-success font-medium" : "text-danger font-medium"}>
                      {adms.apiReachable ? "آماده" : adms.apiHttpStatus ? `خطای HTTP ${adms.apiHttpStatus}` : "در دسترس نیست"}
                    </span>
                    <span className="text-muted-foreground">دستگاه آنلاین:</span>
                    <span className={adms.deviceOnline ? "text-success font-medium" : "text-danger font-medium"}>
                      {!adms.apiReachable ? "نامشخص — API قابل خواندن نیست" : adms.deviceOnline ? "بله" : "خیر"}
                    </span>
                    <span className="text-muted-foreground">آخرین حضور دستگاه:</span>
                    <span>{adms.deviceLastSeen ? formatJalaliDateTime(adms.deviceLastSeen) : "—"}</span>
                    <span className="text-muted-foreground">خواندن اسکن‌ها:</span>
                    <span>{adms.readingEnabled ? "فعال" : "غیرفعال"}</span>
                    {adms.feed && (
                      <>
                        <span className="text-muted-foreground">خوراک رویداد:</span>
                        <span>{adms.feed.lastError ? "در انتظار دسترسی به API" : adms.feed.running ? "در حال اجرا" : "متوقف"}</span>
                        <span className="text-muted-foreground">آخرین بررسی خوراک:</span>
                        <span>{adms.feed.lastPollAt ? formatJalaliDateTime(adms.feed.lastPollAt) : "—"}</span>
                      </>
                    )}
                  </div>
                  {adms.note && <div className="text-warning leading-5">{adms.note}</div>}
                  {adms.feed?.lastError && !adms.note && (
                    <div className="text-danger leading-5">خطای خوراک: {adms.feed.lastError}</div>
                  )}
                  {!adms.configured && (
                    <div className="text-warning leading-5">
                      اتصال بک‌اند به سرور ADMS موجود آماده نیست؛ وضعیت سرور را بررسی کنید.
                    </div>
                  )}
                </div>
              )}

              <div className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-[11px] leading-5 text-foreground flex items-start gap-1.5">
                <Info className="size-3.5 mt-0.5 shrink-0 text-warning" aria-hidden />
                <span>
                  {device?.transport === "ADMS_SERVER"
                    ? "اتصال ذخیره‌شده سرور خودکار استفاده می‌شود. آنلاین بودن دستگاه تنها با پاسخ معتبر API برای همین سریال تأیید می‌شود."
                    : "رسیدن به پورت TCP به معنی آمادگی دستگاه نیست؛ تنها اشتراک رویدادهای زنده تأیید نهایی ارتباط است."}
                </span>
              </div>

              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>
                  آخرین ارتباط ثبت‌شده:{" "}
                  {statusQ.data?.device.lastSeenAt ? formatJalaliDateTime(statusQ.data.device.lastSeenAt) : "—"}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs gap-1"
                  disabled={statusQ.isFetching}
                  onClick={() => void statusQ.refetch()}
                >
                  <RefreshCw className={cn("size-3", statusQ.isFetching && "animate-spin")} aria-hidden />
                  بازخوانی
                </Button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
