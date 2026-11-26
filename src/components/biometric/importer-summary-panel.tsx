"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CalendarDays,
  FilePlus2,
  Fingerprint,
  History,
  ImageOff,
  Loader2,
  MapPin,
  ShieldCheck,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, EntryStatusBadge, QuotaPill, JalaliDateInput } from "@/components/shared";
import { GroupDetailDialog } from "@/components/importer-groups/group-detail-dialog";
import { apiFetch } from "@/lib/client-api";
import { useAppStore } from "@/store/app-store";
import type { ImporterSummaryResponse } from "@/lib/biometric/types";
import {
  BIOMETRIC_STATUS_LABELS,
  IMPORTER_TYPE_LABELS,
} from "@/lib/biometric/types";
import { formatJalali, formatJalaliDateTime, formatNumber, toPersianDigits } from "@/lib/jalali";
import { PERIOD_LABELS } from "@/lib/constants";
import { cn } from "@/lib/utils";

// ============================================================
// Importer summary panel (معلومات و سوابق واردکننده)
// Shows after successful fingerprint identification: personal info,
// photo, quota status (from the existing quota engine) and import
// history (from the existing ImportEntry tables — no duplicates).
// ============================================================

export type HistoryPreset = "today" | "7d" | "30d" | "custom";

interface SummaryPanelProps {
  importerId: number | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Start a new import entry for this (already verified) importer. */
  onNewEntry?: (importerId: number) => void;
  verified?: boolean;
}

function windowFor(preset: HistoryPreset, customFrom: string | null, customTo: string | null) {
  const now = new Date();
  const day = 24 * 60 * 60 * 1000;
  const startOfKabulDay = (d: Date) => {
    // approximate Kabul day start (UTC+4:30) — matches summary API expectations
    const x = new Date(d);
    x.setUTCHours(-4, -30, 0, 0);
    return x;
  };
  if (preset === "today") {
    const from = startOfKabulDay(now);
    return { from: from.toISOString(), to: new Date(from.getTime() + day).toISOString() };
  }
  if (preset === "7d") {
    const from = startOfKabulDay(new Date(now.getTime() - 6 * day));
    return { from: from.toISOString(), to: now.toISOString() };
  }
  if (preset === "30d") {
    const from = startOfKabulDay(new Date(now.getTime() - 29 * day));
    return { from: from.toISOString(), to: now.toISOString() };
  }
  return {
    from: customFrom ?? new Date(now.getTime() - 29 * day).toISOString(),
    to: customTo ?? now.toISOString(),
  };
}

export function ImporterSummaryPanel({ importerId, open, onOpenChange, onNewEntry, verified }: SummaryPanelProps) {
  const user = useAppStore((s) => s.user);
  const isAdmin = user?.role === "ADMIN";
  const [preset, setPreset] = React.useState<HistoryPreset>("30d");
  const [customFrom, setCustomFrom] = React.useState<string | null>(null);
  const [customTo, setCustomTo] = React.useState<string | null>(null);
  // Related-record links (معلومات گروپ و مسئولیت)
  const [groupOpen, setGroupOpen] = React.useState<number | null>(null);
  const [repSummaryId, setRepSummaryId] = React.useState<number | null>(null);
  // Memoized so the query key stays STABLE across re-renders (the "now"
  // inside windowFor would otherwise change on every render and cause a
  // fetch loop).
  const w = React.useMemo(
    () => windowFor(preset, customFrom, customTo),
    [preset, customFrom, customTo]
  );

  const summary = useQuery({
    queryKey: ["importer-summary", importerId, w.from, w.to],
    queryFn: () =>
      apiFetch<ImporterSummaryResponse>(`/api/importers/${importerId}/summary?from=${w.from}&to=${w.to}`),
    enabled: open && importerId !== null,
  });

  React.useEffect(() => {
    if (open) {
      setPreset("30d");
      setCustomFrom(null);
      setCustomTo(null);
    }
  }, [open, importerId]);

  const data = summary.data;
  const imp = data?.importer;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[92vh] overflow-hidden flex flex-col" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-primary" />
            معلومات و سوابق واردکننده
            {verified && (
              <Badge variant="outline" className="bg-success-soft text-success border-success/30 gap-1">
                <Fingerprint className="size-3" /> تأیید بایومتریک
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            پروفایل، سهمیه روزانه و تاریخچه واردات — همه ارقام از سیستم موجود محاسبه می‌شود.
          </DialogDescription>
        </DialogHeader>

        {summary.isLoading ? (
          <div className="flex items-center justify-center py-14 gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-5 animate-spin" /> در حال بارگذاری معلومات…
          </div>
        ) : summary.isError ? (
          <div className="rounded-md border border-danger/30 bg-danger-soft text-danger text-sm p-3">
            {(summary.error as Error).message}
          </div>
        ) : imp ? (
          <div className="space-y-4 overflow-y-auto pe-1">
            {/* ---- Personal information ---- */}
            <div className="flex flex-col sm:flex-row gap-4 rounded-xl border bg-card p-4">
              <div className="shrink-0">
                {imp.hasPhoto ? (
                   
                  <img
                    src={`/api/importers/${imp.id}/photo`}
                    alt={`عکس ${imp.name}`}
                    className="size-24 rounded-lg border object-cover bg-muted/40"
                  />
                ) : (
                  <div className="size-24 rounded-lg border border-dashed grid place-items-center text-muted-foreground bg-muted/30">
                    <div className="flex flex-col items-center gap-1 text-[10px]">
                      <ImageOff className="size-5" />
                      عکس نیست
                    </div>
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1 grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-2.5 text-sm">
                <InfoRow label="نام واردکننده" value={imp.name} strong />
                <InfoRow label="نام پدر" value={imp.fatherName ?? "—"} />
                <InfoRow label="نمبر واردکننده" value={imp.importerCode} mono />
                <InfoRow label="نمبر تذکره" value={maskTazkira(imp.tazkiraNumber)} mono />
                <InfoRow label="ولایت" value={imp.province ?? "—"} />
                <InfoRow label="شرکت" value={imp.companyName ?? "—"} />
                <InfoRow label="نوع واردکننده" value={IMPORTER_TYPE_LABELS[imp.importerType] ?? imp.importerType} />
                <InfoRow label="وضعیت ثبت" value={imp.status === "ACTIVE" ? "فعال" : "غیرفعال"} />
                <InfoRow
                  label="ثبت بایومتریک"
                  value={
                    imp.biometricStatus === "ENROLLED"
                      ? BIOMETRIC_STATUS_LABELS[imp.biometricStatus] ?? imp.biometricStatus
                      : "ثبت نشده"
                  }
                />
              </div>
            </div>

            {/* ---- Group membership (معلومات گروپ و مسئولیت) ---- */}
            <div className="rounded-xl border bg-card p-4">
              <div className="flex items-center gap-2 mb-3">
                <Users className="size-4 text-primary" />
                <h3 className="text-sm font-semibold">معلومات گروپ و مسئولیت</h3>
              </div>
              {imp.group ? (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <MembershipRow
                    label="عضو گروپ"
                    value={imp.group.name}
                    sub={`کود: ${imp.group.code}`}
                    onClick={() => setGroupOpen(imp.group!.id)}
                    actionLabel="مشاهده گروپ"
                  />
                  <MembershipRow
                    label="زیرگروپ"
                    value={imp.subgroup?.name ?? "—"}
                    sub={imp.subgroup ? `کود: ${imp.subgroup.code}` : undefined}
                  />
                  <MembershipRow
                    label="نماینده مسئول"
                    value={imp.group.representative?.name ?? "—"}
                    sub={imp.group.representative ? `نمبر: ${imp.group.representative.importerCode}` : undefined}
                    onClick={imp.group.representative ? () => setRepSummaryId(imp.group!.representative!.id) : undefined}
                    actionLabel={imp.group.representative ? "مشاهده نماینده" : undefined}
                  />
                </div>
              ) : (
                <div className="text-xs text-muted-foreground">
                  این واردکننده عضو هیچ گروپ نیست.
                  {imp.importerType === "BORDER_WORKER" ? " (کارگر مرزنشین باید در یک گروپ ثبت شود)" : ""}
                </div>
              )}
            </div>

            {/* ---- Quota section ---- */}
            <div className="rounded-xl border bg-card p-4">
              <div className="flex items-center gap-2 mb-3">
                <MapPin className="size-4 text-primary" />
                <h3 className="text-sm font-semibold">وضعیت سهمیه‌های فعال</h3>
              </div>
              {!data.quotas.length ? (
                <div className="text-xs text-muted-foreground">حد مجاز فعالی برای این واردکننده تعریف نشده است.</div>
              ) : (
                <div className="space-y-2.5">
                  {data.quotas.map((q) => {
                    const isGroup = q.source === "GROUP" && q.perMember;
                    return (
                    <div key={q.limitId} className="rounded-lg border p-3 space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-sm font-medium">
                          {isGroup ? `حد گروپ: ${q.groupName ?? "—"} — سهم هر عضو` : q.source === "GROUP" ? `حد گروپ: ${q.groupName ?? "—"}` : "حد فردی"}
                          <span className="text-xs text-muted-foreground"> — بندر {q.checkpoint.name}</span>
                          {q.restriction && (
                            <span className="text-[10px] text-muted-foreground"> — محدود: {q.restriction}</span>
                          )}
                        </div>
                        <Badge variant="outline" className="bg-muted/60 text-[10px]">
                          {PERIOD_LABELS[q.periodType] ?? q.periodType}
                        </Badge>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <QuotaPill label={isGroup ? "مجاز (هر عضو)" : "مجاز"} value={fmt(q.allowedBaseQuantity)} />
                        <QuotaPill
                          label={isGroup ? "مصرف‌شده این عضو" : "مصرف‌شده"}
                          value={fmt(isGroup ? (q.memberConsumed ?? 0) : q.approvedBaseQuantity)}
                        />
                        <QuotaPill
                          label={isGroup ? "باقی‌مانده این عضو" : "باقی‌مانده"}
                          value={fmt(isGroup ? (q.memberRemaining ?? q.allowedQuantity) : q.remainingBaseQuantity)}
                          tone={q.overQuota ? "danger" : "ok"}
                        />
                        {q.overQuota && (
                          <Badge variant="outline" className="bg-danger-soft text-danger border-danger/30 text-[10px]">
                            از حد مجاز گذشته
                          </Badge>
                        )}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {isGroup ? (
                          <>
                            حد هر عضو: {formatNumber(q.allowedQuantity)} {q.uomSymbol}
                            {q.memberCount != null && (
                              <>
                                {" "}— اعضای فعال: {toPersianDigits(q.memberCount)} — مجموع گروپ: {formatNumber(q.totalAllowedQuantity ?? 0)} {q.uomSymbol}
                              </>
                            )}
                          </>
                        ) : (
                          <>حد تعریف‌شده: {formatNumber(q.allowedQuantity)} {q.uomSymbol}</>
                        )}
                        {q.windowLabel ? ` — ${q.windowLabel}` : ""}
                      </div>
                    </div>
                    );
                  })}
                </div>
              )}
              {/* Today snapshot */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
                <TodayCard label="واردات تأییدشده امروز" value={toPersianDigits(data.today.approvedEntries)} />
                <TodayCard label="مقدار امروز (پایه)" value={fmt(data.today.approvedBaseQuantity)} />
                <TodayCard
                  label="آخرین واردات"
                  value={data.today.lastImportAt ? formatJalali(data.today.lastImportAt) : "—"}
                />
                <TodayCard label="آخرین بندر" value={data.today.lastCheckpointName ?? "—"} />
              </div>
              {data.today.lastCheckpointName && (
                <div className="text-[10px] text-muted-foreground mt-1.5 flex items-center gap-1">
                  <MapPin className="size-3" /> بندر مسئولیت فعلی برای ثبت جدید از سربرگ انتخاب می‌شود.
                </div>
              )}
            </div>

            {/* ---- Import history ---- */}
            <div className="rounded-xl border bg-card p-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
                <div className="flex items-center gap-2">
                  <History className="size-4 text-primary" />
                  <h3 className="text-sm font-semibold">سوابق واردات</h3>
                  <span className="text-xs text-muted-foreground">
                    ({toPersianDigits(data.entriesTotal)} ثبت)
                  </span>
                </div>
                <Tabs value={preset} onValueChange={(v) => setPreset(v as HistoryPreset)}>
                  <TabsList className="h-8">
                    <TabsTrigger value="today" className="text-xs h-7 px-2.5">امروز</TabsTrigger>
                    <TabsTrigger value="7d" className="text-xs h-7 px-2.5">۷ روز</TabsTrigger>
                    <TabsTrigger value="30d" className="text-xs h-7 px-2.5">۳۰ روز</TabsTrigger>
                    <TabsTrigger value="custom" className="text-xs h-7 px-2.5 gap-1">
                      <CalendarDays className="size-3" /> بازه مشخص
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>
              {preset === "custom" && (
                <div className="grid grid-cols-2 gap-2 mb-3 max-w-xs">
                  <JalaliDateInput value={customFrom} onChange={setCustomFrom} placeholder="از تاریخ" />
                  <JalaliDateInput value={customTo} onChange={setCustomTo} placeholder="تا تاریخ" />
                </div>
              )}
              {!data.entries.length ? (
                <EmptyState icon={<History className="size-8" />} title="در این بازه وارداتی ثبت نشده است" />
              ) : (
                <div className="rounded-md border overflow-hidden">
                  <div className="overflow-x-auto max-h-64 overflow-y-auto">
                    <Table>
                      <TableHeader className="sticky top-0 bg-muted z-10">
                        <TableRow>
                          <TableHead>نمبر ثبت</TableHead>
                          <TableHead>تاریخ و ساعت</TableHead>
                          <TableHead>بندر</TableHead>
                          <TableHead>اجناس</TableHead>
                          <TableHead>وضعیت</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.entries.map((e) => (
                          <TableRow key={e.id}>
                            <TableCell className="font-mono text-xs">{e.entryNumber}</TableCell>
                            <TableCell className="text-xs whitespace-nowrap">
                              {formatJalaliDateTime(e.importDatetime)}
                            </TableCell>
                            <TableCell className="text-xs">{e.checkpoint.name}</TableCell>
                            <TableCell className="text-xs">
                              <span className="block max-w-64 truncate" title={itemsText(e.items)}>
                                {itemsText(e.items)}
                              </span>
                            </TableCell>
                            <TableCell>
                              <EntryStatusBadge status={e.status} />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : null}

        {/* Footer action */}
        {imp && (
          <div className="pt-2 border-t flex items-center justify-between gap-2">
            <div className="text-xs text-muted-foreground">
              اسکن اثر انگشت خودبه‌خود وارداتی ثبت یا تأیید نمی‌کند؛ ثبت جدید همچنان از کنترل سهمیه می‌گذرد.
            </div>
            {onNewEntry && imp.status === "ACTIVE" && (
              <Button
                onClick={() => onNewEntry(imp.id)}
                className="gap-1.5 shrink-0"
              >
                <FilePlus2 className="size-4" />
                ثبت واردات جدید
              </Button>
            )}
          </div>
        )}
      </DialogContent>
      {/* Related records: group detail + nested representative profile —
          mounted only when requested (avoids closed-dialog recursion). */}
      {groupOpen !== null && (
        <GroupDetailDialog
          groupId={groupOpen}
          open={true}
          onOpenChange={(v) => !v && setGroupOpen(null)}
          isAdmin={isAdmin}
        />
      )}
      {repSummaryId !== null && (
        <ImporterSummaryPanel
          importerId={repSummaryId}
          open={true}
          onOpenChange={(v) => !v && setRepSummaryId(null)}
        />
      )}
    </Dialog>
  );
}

function InfoRow({ label, value, strong, mono }: { label: string; value: string; strong?: boolean; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={cn("truncate", strong && "font-semibold", mono && "font-mono text-xs")} title={value}>
        {value}
      </div>
    </div>
  );
}

/** Membership row with an optional link-action (opens group / representative). */
function MembershipRow({
  label,
  value,
  sub,
  onClick,
  actionLabel,
}: {
  label: string;
  value: string;
  sub?: string;
  onClick?: () => void;
  actionLabel?: string;
}) {
  return (
    <div className="rounded-lg border bg-muted/20 p-2.5 min-w-0">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="text-sm font-medium truncate" title={value}>
        {value}
      </div>
      {sub && <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div>}
      {onClick && actionLabel && (
        <button
          type="button"
          onClick={onClick}
          className="mt-1.5 text-[11px] font-medium text-primary hover:underline inline-flex items-center gap-1"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function TodayCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/30 px-2.5 py-2">
      <div className="text-[10px] text-muted-foreground truncate">{label}</div>
      <div className="text-sm font-bold truncate">{value}</div>
    </div>
  );
}

function itemsText(items: Array<{ itemName: string; quantity: number; uomSymbol: string }>): string {
  return items.map((i) => `${i.itemName}: ${formatNumber(i.quantity)} ${i.uomSymbol}`).join("، ");
}

function fmt(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : formatNumber(v);
}

/** Mask Tazkira middle digits — shown in full only in the edit form. */
function maskTazkira(v: string | null): string {
  if (!v) return "—";
  if (v.length <= 4) return v;
  return `${v.slice(0, Math.max(2, v.length - 4))}${"•".repeat(4)}`;
}
