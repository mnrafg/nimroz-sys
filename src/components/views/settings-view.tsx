"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarCheck, CalendarDays, Clock, Eye, History, Loader2, Save, Server, Settings2, ShieldAlert, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/client-api";
import { formatJalali, formatJalaliDateTime, toPersianDigits } from "@/lib/jalali";
import { ACTION_LABELS, APP_NAME, ORG_SHORT, RECORD_TYPE_LABELS } from "@/lib/constants";
import { EmptyState, FieldError, PageHeader, TablePagination } from "@/components/shared";
import { useAppStore, type BaseView } from "@/store/app-store";

// ============================================================
// Types
// ============================================================

interface AuditLogRow {
  id: number;
  userId: number | null;
  action: string;
  recordType: string;
  recordId: number | null;
  oldValues: string | null;
  newValues: string | null;
  createdAt: string;
  user: { name: string } | null;
}

interface AuditLogsResponse {
  logs: AuditLogRow[];
  total: number;
  page: number;
  pageCount: number;
  facets: { recordTypes: string[]; actions: string[] };
}

interface SettingItem {
  key: string;
  label: string;
  value: string | number | null;
  overridden: boolean;
}

/** Where an audit record can be opened (when the admin may see it). */
const RECORD_VIEW: Record<string, BaseView> = {
  IMPORT_ENTRY: "entries",
  IMPORTER: "importers",
  IMPORT_LIMIT: "limits",
  IMPORTER_GROUP: "importers",
  IMPORTER_SUBGROUP: "importers",
  ITEM: "items",
  UOM: "uoms",
  UOM_CONVERSION: "uoms",
  CHECKPOINT: "checkpoints",
  USER: "users",
  SYSTEM_SETTING: "settings",
};

const TH_CLS = "sticky top-0 bg-muted z-10";

/** Pretty-print a stored JSON string; returns null when empty/invalid. */
function prettyJson(v: string | null | undefined): string | null {
  if (!v) return null;
  try {
    return JSON.stringify(JSON.parse(v), null, 2);
  } catch {
    return v;
  }
}

const ACTION_TONES: Record<string, string> = {
  CREATE: "bg-success-soft text-success border-success/30",
  UPDATE: "bg-warning-soft text-warning border-warning/30",
  STATUS_CHANGE: "bg-warning-soft text-warning border-warning/30",
  DELETE: "bg-danger-soft text-danger border-danger/30",
  LOGIN: "bg-muted text-muted-foreground border-border",
  LOGOUT: "bg-muted text-muted-foreground border-border",
};

function SettingsView() {
  const user = useAppStore((s) => s.user);
  const setView = useAppStore((s) => s.setView);
  const setPendingSearch = useAppStore((s) => s.setPendingSearch);
  const setEntryIntent = useAppStore((s) => s.setEntryIntent);
  const isAdmin = user?.role === "ADMIN";

  // ---------- audit filters + pagination ----------
  const [recordTypeFilter, setRecordTypeFilter] = React.useState("all");
  const [actionFilter, setActionFilter] = React.useState("all");
  const [page, setPage] = React.useState(1);
  const auditQ = useQuery({
    placeholderData: (prev) => prev,
    queryKey: ["audit-logs", recordTypeFilter, actionFilter, page],
    queryFn: () => {
      const p = new URLSearchParams();
      if (recordTypeFilter !== "all") p.set("recordType", recordTypeFilter);
      if (actionFilter !== "all") p.set("action", actionFilter);
      p.set("page", String(page));
      p.set("pageSize", "20");
      return apiFetch<AuditLogsResponse>(`/api/audit-logs?${p.toString()}`);
    },
    enabled: isAdmin,
  });

  // ---------- automation settings ----------
  const settingsQ = useQuery({
    queryKey: ["system-settings"],
    queryFn: () => apiFetch<{ items: SettingItem[] }>("/api/settings"),
    enabled: isAdmin,
    staleTime: 30_000,
  });
  const [settingValues, setSettingValues] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    if (settingsQ.data?.items) {
      const next: Record<string, string> = {};
      for (const item of settingsQ.data.items) next[item.key] = String(item.value ?? "");
      setSettingValues(next);
    }
  }, [settingsQ.data]);

  const saveSettings = useMutation({
    mutationFn: () =>
      apiFetch("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          values: Object.entries(settingValues).map(([key, value]) => ({ key, value })),
        }),
      }),
    onSuccess: () => {
      toast.success("تنظیمات اتوماسیون ذخیره شد.");
      settingsQ.refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const [detailLog, setDetailLog] = React.useState<AuditLogRow | null>(null);
  const [settingError, setSettingError] = React.useState<string | undefined>(undefined);

  // ---------- admin guard ----------
  if (!isAdmin) {
    return (
      <EmptyState
        icon={<ShieldAlert className="size-12" />}
        title="دسترسی محدود"
        description="شما اجازه دسترسی به این بخش را ندارید."
      />
    );
  }

  const logs = auditQ.data?.logs ?? [];
  const oldPretty = detailLog ? prettyJson(detailLog.oldValues) : null;
  const newPretty = detailLog ? prettyJson(detailLog.newValues) : null;

  /** Open the record an audit entry refers to (when viewable). */
  const openAuditRecord = (log: AuditLogRow) => {
    const view = RECORD_VIEW[log.recordType];
    if (!view || log.recordId === null) return;
    if (view === "entries") {
      setEntryIntent(null);
      setPendingSearch({ view: "entries", q: "", focusId: log.recordId });
    } else if (view === "importers") {
      setPendingSearch({ view: "importers", q: "", focusId: log.recordId });
    } else {
      // Master-data views: navigating is the useful action.
    }
    setView(view);
  };

  const infoCards: { title: string; value: string; icon: React.ReactNode }[] = [
    {
      title: "نام سیستم",
      value: `${APP_NAME} ${ORG_SHORT}`,
      icon: <Server className="size-4 text-primary" />,
    },
    {
      title: "منطقه‌ی زمانی",
      // Canonical timezone label — Asia/Kabul (UTC+04:30, no DST).
      value: "آسیا/کابل (UTC+۴:۳۰)",
      icon: <Clock className="size-4 text-primary" />,
    },
    {
      title: "تقویم",
      value: "هجری شمسی (افغانستان)",
      icon: <CalendarDays className="size-4 text-primary" />,
    },
    {
      title: "تاریخ امروز",
      value: formatJalali(new Date(), { weekday: true }),
      icon: <CalendarCheck className="size-4 text-primary" />,
    },
    {
      title: "نسخه",
      value: toPersianDigits("1.1"),
      icon: <Tag className="size-4 text-primary" />,
    },
  ];

  return (
    <div>
      <PageHeader
        title="تنظیمات سیستم"
        description="معلومات عمومی سیستم، تنظیمات اتوماسیون و سابقه فعالیت‌های امنیتی کاربران."
      />

      {/* ---------- Section 1: system info ---------- */}
      <section aria-label="اطلاعات سیستم" className="mb-6">
        <h2 className="text-base font-semibold mb-3">اطلاعات سیستم</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {infoCards.map((c) => (
            <Card key={c.title} className="py-0">
              <CardContent className="p-4 flex items-center gap-3">
                <div className="size-10 rounded-md bg-primary/10 grid place-items-center shrink-0">
                  {c.icon}
                </div>
                <div className="min-w-0">
                  <div className="text-xs text-muted-foreground">{c.title}</div>
                  <div className="font-semibold text-sm mt-0.5 truncate">{c.value}</div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* ---------- Section 2: automation settings ---------- */}
      <section aria-label="تنظیمات اتوماسیون" className="mb-6">
        <h2 className="text-base font-semibold mb-3">تنظیمات اتوماسیون</h2>
        <Card className="py-0">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Settings2 className="size-4 text-gold" />
              پارامترهای تولید خودکار و هشدارها
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-1">
            {settingsQ.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                <Loader2 className="size-4 animate-spin" aria-hidden /> در حال بارگذاری…
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  تغییر این مقادیر فقط رفتارهای جدید را تغییر می‌دهد — نمبرها و کودهای صادره‌شده قبلی هیچ‌گاه تغییر نمی‌کنند.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {(settingsQ.data?.items ?? []).map((item) => {
                    const isNumeric = typeof item.value === "number";
                    return (
                      <div key={item.key} className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <Label htmlFor={`setting-${item.key}`} className="text-xs">
                            {item.label}
                          </Label>
                          {item.overridden && (
                            <Badge variant="outline" className="bg-muted text-[9px]">
                              تغییر یافته
                            </Badge>
                          )}
                        </div>
                        <Input
                          id={`setting-${item.key}`}
                          dir="ltr"
                          className="text-left font-mono text-xs"
                          inputMode={isNumeric ? "numeric" : undefined}
                          value={settingValues[item.key] ?? ""}
                          onChange={(e) => {
                            setSettingValues((v) => ({ ...v, [item.key]: e.target.value }));
                            setSettingError(undefined);
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
                {settingError && <FieldError message={settingError} />}
                <Button onClick={() => saveSettings.mutate()} disabled={saveSettings.isPending}>
                  {saveSettings.isPending ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <Save className="size-4" aria-hidden />
                  )}
                  ذخیره تنظیمات
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      {/* ---------- Section 3: audit logs ---------- */}
      <section aria-label="سابقه فعالیت سیستم">
        <h2 className="text-base font-semibold mb-3">سابقه فعالیت سیستم (لاگ‌های امنیتی)</h2>
        <Card className="py-0">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <History className="size-4 text-gold" />
              فعالیت‌های سیستم
              {auditQ.data && (
                <span className="text-xs font-normal text-muted-foreground">
                  ({toPersianDigits(auditQ.data.total)} رکورد)
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-1">
            {/* Filters */}
            <div className="flex flex-wrap gap-2 mb-3">
              <Select
                value={recordTypeFilter}
                onValueChange={(v) => {
                  setRecordTypeFilter(v);
                  setPage(1);
                }}
              >
                <SelectTrigger className="sm:w-52 h-9" aria-label="نوع رکورد">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-64">
                  <SelectItem value="all">همه انواع رکورد</SelectItem>
                  {(auditQ.data?.facets.recordTypes ?? []).map((t) => (
                    <SelectItem key={t} value={t}>
                      {RECORD_TYPE_LABELS[t] ?? t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={actionFilter}
                onValueChange={(v) => {
                  setActionFilter(v);
                  setPage(1);
                }}
              >
                <SelectTrigger className="sm:w-44 h-9" aria-label="نوع عملیه">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-64">
                  <SelectItem value="all">همه عملیات</SelectItem>
                  {(auditQ.data?.facets.actions ?? []).map((a) => (
                    <SelectItem key={a} value={a}>
                      {ACTION_LABELS[a] ?? a}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="rounded-md border overflow-hidden">
              <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className={TH_CLS}>کاربر</TableHead>
                      <TableHead className={TH_CLS}>عملیه</TableHead>
                      <TableHead className={TH_CLS}>نوع رکورد</TableHead>
                      <TableHead className={`${TH_CLS} text-center`}>شناسه رکورد</TableHead>
                      <TableHead className={TH_CLS}>تاریخ</TableHead>
                      <TableHead className={TH_CLS}>جزئیات</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {auditQ.isLoading
                      ? Array.from({ length: 8 }).map((_, i) => (
                          <TableRow key={i}>
                            {Array.from({ length: 6 }).map((__, j) => (
                              <TableCell key={j}>
                                <Skeleton className="h-4 w-full" />
                              </TableCell>
                            ))}
                          </TableRow>
                        ))
                      : logs.length === 0
                        ? (
                          <TableRow>
                            <TableCell colSpan={6}>
                              <EmptyState
                                icon={<History className="size-10" />}
                                title="هیچ سابقه فعالیت موجود نیست"
                                description="به‌محض انجام عملیات در سیستم، سابقه فعالیت‌ها در اینجا ثبت خواهد شد."
                              />
                            </TableCell>
                          </TableRow>
                        )
                        : logs.map((log) => {
                            const canOpen =
                              log.recordId !== null && Boolean(RECORD_VIEW[log.recordType]);
                            return (
                              <TableRow key={log.id}>
                                <TableCell className="font-medium align-middle whitespace-nowrap">
                                  {log.user?.name ?? <span className="text-muted-foreground">—</span>}
                                </TableCell>
                                <TableCell className="align-middle">
                                  <Badge
                                    variant="outline"
                                    className={`font-medium ${ACTION_TONES[log.action] ?? "bg-muted text-muted-foreground border-border"}`}
                                  >
                                    {ACTION_LABELS[log.action] ?? log.action}
                                  </Badge>
                                </TableCell>
                                <TableCell className="align-middle">
                                  {RECORD_TYPE_LABELS[log.recordType] ?? log.recordType}
                                </TableCell>
                                <TableCell className="text-center align-middle">
                                  {canOpen ? (
                                    <button
                                      type="button"
                                      className="font-mono text-xs underline hover:text-primary"
                                      onClick={() => openAuditRecord(log)}
                                      title="باز کردن رکورد مربوطه"
                                      dir="ltr"
                                    >
                                      {log.recordId}
                                    </button>
                                  ) : log.recordId !== null ? (
                                    toPersianDigits(log.recordId)
                                  ) : (
                                    "—"
                                  )}
                                </TableCell>
                                <TableCell className="align-middle whitespace-nowrap text-xs">
                                  {formatJalaliDateTime(log.createdAt)}
                                </TableCell>
                                <TableCell className="align-middle">
                                  {prettyJson(log.oldValues) || prettyJson(log.newValues) ? (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => setDetailLog(log)}
                                      aria-label={`مشاهده جزئیات رکورد ${log.id}`}
                                    >
                                      <Eye className="size-3.5" />
                                      مشاهده
                                    </Button>
                                  ) : (
                                    <span className="text-xs text-muted-foreground">—</span>
                                  )}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                  </TableBody>
                </Table>
              </div>
            </div>
            <TablePagination
              page={page}
              pageCount={auditQ.data?.pageCount ?? 1}
              total={auditQ.data?.total ?? 0}
              onPage={setPage}
              entityLabel="رکورد سابقه"
            />
          </CardContent>
        </Card>
      </section>

      {/* ---------- Log details dialog ---------- */}
      <Dialog open={!!detailLog} onOpenChange={(v) => !v && setDetailLog(null)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>جزئیات رکورد فعالیت</DialogTitle>
            <DialogDescription>
              {detailLog
                ? `${RECORD_TYPE_LABELS[detailLog.recordType] ?? detailLog.recordType} — ${
                    ACTION_LABELS[detailLog.action] ?? detailLog.action
                  } — ${formatJalaliDateTime(detailLog.createdAt)}`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <div className="text-xs font-semibold mb-1.5">مقادیر قبلی</div>
              {oldPretty ? (
                <pre dir="ltr" className="text-xs bg-muted p-2 rounded overflow-auto max-h-64">
                  {oldPretty}
                </pre>
              ) : (
                <div className="text-xs text-muted-foreground">—</div>
              )}
            </div>
            <div>
              <div className="text-xs font-semibold mb-1.5">مقادیر جدید</div>
              {newPretty ? (
                <pre dir="ltr" className="text-xs bg-muted p-2 rounded overflow-auto max-h-64">
                  {newPretty}
                </pre>
              ) : (
                <div className="text-xs text-muted-foreground">—</div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export { SettingsView };
export default SettingsView;
