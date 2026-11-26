"use client";

import * as React from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertCircle,
  CalendarDays,
  CalendarRange,
  FileDown,
  FileSpreadsheet,
  FileX,
  Gauge,
  Landmark,
  Loader2,
  Package,
  Printer,
  ShieldAlert,
  SlidersHorizontal,
  Table2,
  Truck,
  type LucideIcon,
} from "lucide-react";
import { jsPDF } from "jspdf";
import html2canvas from "html2canvas-pro";
import { toGregorian as j2gDate } from "jalaali-js";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  EmptyState,
  JalaliDateInput,
  PageHeader,
  PortScopeChip,
  TablePagination,
  TableSkeleton,
  usePagedRows,
} from "@/components/shared";
import { SearchSelect, toOptions } from "@/components/ui/search-select";
import { BrandLogo } from "@/components/brand";
import { apiFetch, downloadFile } from "@/lib/client-api";
import { useAppStore } from "@/store/app-store";
import { REPORT_TYPE_LABELS } from "@/lib/constants";
import { breadcrumbItems } from "@/lib/nav";
import {
  formatJalali,
  formatJalaliDateTime,
  formatNumber,
  jalaliToUtc,
  JALALI_MONTHS,
  toJalali,
  toPersianDigits,
} from "@/lib/jalali";
import { cn } from "@/lib/utils";

// ============================================================
// Types & constants
// ============================================================

type ReportType =
  | "daily"
  | "monthly"
  | "importer"
  | "item"
  | "checkpoint"
  | "remaining_quota"
  | "exception";

interface ReportColumn {
  key: string;
  label: string;
  type?: "number" | "text";
}

type ReportRow = Record<string, string | number>;

interface ReportSummaryItem {
  label: string;
  value: string | number;
}

interface ReportMeta {
  from?: string | null;
  to?: string | null;
  checkpointName?: string | null;
  importerName?: string | null;
  groupName?: string | null;
  itemName?: string | null;
  asOf?: string | null;
  generatedBy: string;
  generatedAt: string;
}

interface ReportPayload {
  report: {
    type: string;
    title: string;
    columns: ReportColumn[];
    rows: ReportRow[];
    summary: ReportSummaryItem[];
    meta: ReportMeta;
  };
}

interface NamedEntity {
  id: number;
  name: string;
}

const ALL = "all";
const DAY_MS = 86_400_000;

const REPORT_TYPES: { key: ReportType; icon: LucideIcon }[] = [
  { key: "daily", icon: CalendarDays },
  { key: "monthly", icon: CalendarRange },
  { key: "importer", icon: Truck },
  { key: "item", icon: Package },
  { key: "checkpoint", icon: Landmark },
  { key: "remaining_quota", icon: Gauge },
  { key: "exception", icon: ShieldAlert },
];

// ============================================================
// Helpers
// ============================================================

/** Convert a start-of-day ISO to end-of-day ISO (23:59:59.999) for inclusive range queries. */
function endOfDayIso(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  return new Date(t + DAY_MS - 1).toISOString();
}

/** Build the query string for /api/reports and /api/reports/export (omits empty values). */
function buildReportParams(
  type: ReportType,
  from: string | null,
  to: string | null,
  checkpointSel: string,
  groupSel: string,
  importerSel: string,
  itemSel: string,
  q: string
): string {
  const p = new URLSearchParams();
  p.set("type", type);
  if (from) p.set("from", from);
  if (to) p.set("to", endOfDayIso(to));
  if (checkpointSel !== ALL) p.set("checkpointId", checkpointSel);
  if (groupSel !== ALL) p.set("groupId", groupSel);
  if (importerSel !== ALL) p.set("importerId", importerSel);
  if (itemSel !== ALL) p.set("itemId", itemSel);
  if (q.trim()) p.set("q", q.trim());
  // Remaining-quota report: explicit "as of" instant (today) — printed
  // figures are unambiguous.
  if (type === "remaining_quota") p.set("asOf", new Date().toISOString());
  return p.toString();
}

/** Format a summary value: numbers via formatNumber, empty strings as dash. */
function summaryValue(v: string | number): string {
  if (typeof v === "number") return formatNumber(v);
  return v === "" ? "—" : String(v);
}

// ============================================================
// Reports view — one coherent reports workspace
// ============================================================

export default function ReportsView({
  initialType = "daily",
}: {
  initialType?: string;
}) {
  const user = useAppStore((s) => s.user);
  const isNationwide = user?.role === "ADMIN";
  // Filters
  const [type, setType] = React.useState<ReportType>(
    (initialType as ReportType) ?? "daily"
  );
  const [from, setFrom] = React.useState<string | null>(null);
  const [to, setTo] = React.useState<string | null>(null);
  // Monthly report: explicit Solar-Hijri month/year selection instead of
  // a free date range (defaults to the CURRENT Jalali month).
  const todayJ = toJalali(new Date());
  const [monthSel, setMonthSel] = React.useState(String(todayJ.jm));
  const [yearSel, setYearSel] = React.useState(String(todayJ.jy));
  const [checkpointSel, setCheckpointSel] = React.useState(ALL);
  const [groupSel, setGroupSel] = React.useState(ALL);
  const [importerSel, setImporterSel] = React.useState(ALL);
  const [itemSel, setItemSel] = React.useState(ALL);
  const [qInput, setQInput] = React.useState("");
  const [q, setQ] = React.useState("");
  const [exportingExcel, setExportingExcel] = React.useState(false);
  const [exportingPdf, setExportingPdf] = React.useState(false);

  // Debounce the search input so auto-refetch does not fire per keystroke
  React.useEffect(() => {
    const t = setTimeout(() => setQ(qInput), 400);
    return () => clearTimeout(t);
  }, [qInput]);

  // MEANINGFUL DEFAULTS per report type (server enforces the same rules):
  //   daily    → today (Kabul) with quick previous-day/today buttons
  //   monthly  → current Solar-Hijri month via the month/year picker
  //   others   → unrestricted (all-time), clearly labeled in the header
  const applyTypeDefaults = React.useCallback((t: ReportType) => {
    if (t === "daily") {
      const j = toJalali(new Date());
      setFrom(jalaliToUtc(j.jy, j.jm, j.jd).toISOString());
      setTo(jalaliToUtc(j.jy, j.jm, j.jd).toISOString());
    } else if (t === "monthly") {
      const j = toJalali(new Date());
      setMonthSel(String(j.jm));
      setYearSel(String(j.jy));
      applyMonthWindow(String(j.jy), String(j.jm));
    } else {
      setFrom(null);
      setTo(null);
    }
     
  }, []);

  const applyMonthWindow = (yStr: string, mStr: string) => {
    const jy = Number(yStr);
    const jm = Number(mStr);
    const gFrom = j2gDate(jy, jm, 1);
    const njy = jm === 12 ? jy + 1 : jy;
    const njm = jm === 12 ? 1 : jm + 1;
    const gTo = j2gDate(njy, njm, 1);
    setFrom(
      new Date(Date.UTC(gFrom.gy, gFrom.gm - 1, gFrom.gd, 0, 0, 0) - 270 * 60000).toISOString()
    );
    setTo(
      new Date(Date.UTC(gTo.gy, gTo.gm - 1, gTo.gd, 0, 0, 0) - 270 * 60000).toISOString()
    );
  };

  const onTypeChange = (t: ReportType) => {
    setType(t);
    applyTypeDefaults(t);
  };

  React.useEffect(() => {
    applyTypeDefaults(type);
     
  }, []);

  const params = buildReportParams(type, from, to, checkpointSel, groupSel, importerSel, itemSel, q);

  // Main report query — auto-fetches on mount ('daily') and on any filter change
  const reportQuery = useQuery({
    queryKey: ["report", type, from, to, checkpointSel, groupSel, importerSel, itemSel, q],
    queryFn: () => apiFetch<ReportPayload>(`/api/reports?${params}`),
    placeholderData: keepPreviousData,
  });

  // Master lists for the filter selects (fetched once)
  const checkpointsQuery = useQuery({
    queryKey: ["checkpoints"],
    queryFn: () => apiFetch<{ checkpoints: NamedEntity[] }>("/api/checkpoints"),
    staleTime: Infinity,
  });
  // Active groups — the group filter narrows every report to the entries of
  // the group's members (and the group's own shared quota balance).
  const groupsQuery = useQuery({
    queryKey: ["importer-groups", "report-filter"],
    queryFn: () =>
      apiFetch<{ groups: NamedEntity[] }>("/api/importer-groups?status=ACTIVE"),
    staleTime: 60_000,
  });
  // Importer list follows the selected group — picking a گروپ narrows the
  // individual (واردکننده) filter to that group's members.
  const importersQuery = useQuery({
    queryKey: ["importers", "report-filter", groupSel],
    queryFn: () =>
      apiFetch<{ importers: NamedEntity[] }>(
        groupSel !== ALL
          ? `/api/importers?groupId=${groupSel}`
          : "/api/importers"
      ),
    staleTime: 60_000,
  });
  const itemsQuery = useQuery({
    queryKey: ["items"],
    queryFn: () => apiFetch<{ items: NamedEntity[] }>("/api/items"),
    staleTime: Infinity,
  });

  const report = reportQuery.data?.report;
  const isFetching = reportQuery.isFetching;

  const isTodaySelected = React.useMemo(() => {
    if (!from || !to) return false;
    const j = toJalali(new Date());
    const todayIso = jalaliToUtc(j.jy, j.jm, j.jd).toISOString();
    return from === todayIso && to === todayIso;
  }, [from, to]);

  // Report rows are paginated client-side — thousands of rows never render
  // at once (PDF/print expand the container for the full snapshot).
  const paging = usePagedRows(report?.rows ?? [], 50);

  // Toast on background fetch errors
  React.useEffect(() => {
    if (reportQuery.error) {
      toast.error(
        reportQuery.error instanceof Error
          ? reportQuery.error.message
          : "خطا در بارگذاری گزارش"
      );
    }
  }, [reportQuery.error]);

  // ---------- Handlers ----------

  const handleShow = async () => {
    const res = await reportQuery.refetch();
    if (res.isError) {
      toast.error(
        res.error instanceof Error ? res.error.message : "خطا در بارگذاری گزارش"
      );
    } else {
      toast.success("گزارش بارگذاری شد");
    }
  };

  const handleExcel = async () => {
    setExportingExcel(true);
    const toastId = toast.loading("فایل اکسل در حال دانلود است...");
    try {
      await downloadFile(`/api/reports/export?${params}`);
      toast.success("فایل اکسل با موفقیت دانلود شد", { id: toastId });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "خطا در دانلود فایل اکسل", {
        id: toastId,
      });
    } finally {
      setExportingExcel(false);
    }
  };

  const handlePdf = async () => {
    const el = document.getElementById("report-print-area");
    if (!el) {
      toast.error("ابتدا گزارش را نمایش دهید.");
      return;
    }
    setExportingPdf(true);
    // Temporarily expand the table scroll container so the capture includes all rows
    const scroller = el.querySelector<HTMLElement>("[data-report-table-scroll]");
    const prevMaxH = scroller?.style.maxHeight ?? "";
    const prevOverflow = scroller?.style.overflow ?? "";
    if (scroller) {
      scroller.style.maxHeight = "none";
      scroller.style.overflow = "visible";
    }
    try {
      const canvas = await html2canvas(el, { scale: 2, backgroundColor: "#ffffff" });
      const pdf = new jsPDF({
        orientation: canvas.width > canvas.height ? "landscape" : "portrait",
        unit: "pt",
        format: "a4",
      });
      const pw = pdf.internal.pageSize.getWidth();
      const ph = pdf.internal.pageSize.getHeight();
      const imgW = pw - 24;
      const imgH = (canvas.height * imgW) / canvas.width;
      const pageContentHeight = ph - 24;
      const img = canvas.toDataURL("image/png");
      const pages = Math.max(1, Math.ceil(imgH / pageContentHeight));
      for (let i = 0; i < pages; i++) {
        if (i > 0) pdf.addPage();
        pdf.addImage(img, "PNG", 12, 12 - i * pageContentHeight, imgW, imgH, undefined, "FAST");
      }
      pdf.save(`report-${report?.type ?? type}-${Date.now()}.pdf`);
      toast.success("PDF آماده شد");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "خطا در تولید PDF");
    } finally {
      if (scroller) {
        scroller.style.maxHeight = prevMaxH;
        scroller.style.overflow = prevOverflow;
      }
      setExportingPdf(false);
    }
  };

  const handlePrint = () => {
    if (!report) {
      toast.error("ابتدا گزارش را نمایش دهید.");
      return;
    }
    window.print();
  };

  // ---------- Meta chips for the report header ----------

  const meta = report?.meta;
  // NOTE: the server sends meta.from/to/asOf/generatedAt ALREADY formatted
  // in Dari/Jalali — they are displayed verbatim (re-parsing a formatted
  // string yields "—").
  const metaChips: string[] = [];
  if (meta?.from && meta?.to) {
    metaChips.push(`بازه: ${meta.from} — ${meta.to}`);
  } else if (meta?.from) {
    metaChips.push(`از تاریخ: ${meta.from}`);
  } else if (meta?.to) {
    metaChips.push(`تا تاریخ: ${meta.to}`);
  }
  if (meta?.checkpointName) metaChips.push(`بندر: ${meta.checkpointName}`);
  if (meta?.groupName) metaChips.push(`گروپ: ${meta.groupName}`);
  if (meta?.importerName) metaChips.push(`واردکننده: ${meta.importerName}`);
  if (meta?.itemName) metaChips.push(`جنس: ${meta.itemName}`);
  if (meta?.asOf) metaChips.push(`تاریخ محاسبه (as-of): ${meta.asOf}`);
  if (meta?.generatedBy) metaChips.push(`ایجادکننده: ${meta.generatedBy}`);
  if (meta?.generatedAt) metaChips.push(`زمان تولید: ${meta.generatedAt}`);

  return (
    <div className="space-y-4">
      <PageHeader
        title="گزارشات"
        description="کارگاه گزارشات رسمی سیستم کنترل واردات مرزی با خروجی اکسل، PDF و چاپ"
        breadcrumbs={breadcrumbItems("reports")}
        actions={
          isFetching ? (
            <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin text-gold" aria-hidden />
              در حال بارگذاری گزارش...
            </span>
          ) : undefined
        }
      />

      {/* Workspace — type selector + filters + actions in ONE card */}
      <Card className="no-print rounded-xl">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <SlidersHorizontal className="size-4 text-gold" aria-hidden />
            کارگاه گزارشات
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Report type selector — quiet segmented grid */}
          <div
            role="group"
            aria-label="انتخاب نوع گزارش"
            className="grid grid-cols-2 gap-2"
          >
            {REPORT_TYPES.map(({ key, icon: Icon }) => {
              const selected = type === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => onTypeChange(key)}
                  aria-pressed={selected}
                  className={cn(
                    "flex min-h-[44px] items-center justify-start gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
                    selected
                      ? "border-primary/30 bg-secondary text-primary"
                      : "border-border bg-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                  )}
                >
                  <Icon className="size-4 shrink-0 text-gold" aria-hidden />
                  <span className="truncate">{REPORT_TYPE_LABELS[key] ?? key}</span>
                </button>
              );
            })}
          </div>

          {/* Filters */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {type === "daily" && (
              <div className="space-y-1.5 min-w-0 sm:col-span-2 lg:col-span-1">
                <Label className="text-xs text-muted-foreground">روز گزارش</Label>
                <div className="flex flex-wrap gap-1.5">
                  <Button
                    type="button"
                    variant={isTodaySelected ? "secondary" : "outline"}
                    size="sm"
                    onClick={() => {
                      const j = toJalali(new Date());
                      setFrom(jalaliToUtc(j.jy, j.jm, j.jd).toISOString());
                      setTo(jalaliToUtc(j.jy, j.jm, j.jd).toISOString());
                    }}
                  >
                    امروز
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const d = new Date(Date.now() - DAY_MS);
                      const j = toJalali(d);
                      setFrom(jalaliToUtc(j.jy, j.jm, j.jd).toISOString());
                      setTo(jalaliToUtc(j.jy, j.jm, j.jd).toISOString());
                    }}
                  >
                    روز گذشته
                  </Button>
                  <span className="text-[11px] text-muted-foreground self-center">
                    یا تاریخ دقیق را از فیلدهای زیر انتخاب کنید
                  </span>
                </div>
              </div>
            )}
            {type === "monthly" ? (
              <>
                <div className="space-y-1.5 min-w-0">
                  <Label className="text-xs text-muted-foreground">ماه (هجری شمسی)</Label>
                  <Select value={monthSel} onValueChange={(v) => { setMonthSel(v); applyMonthWindow(yearSel, v); }}>
                    <SelectTrigger aria-label="ماه">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="max-h-64">
                      {JALALI_MONTHS.map((m, i) => (
                        <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5 min-w-0">
                  <Label className="text-xs text-muted-foreground">سال</Label>
                  <Select value={yearSel} onValueChange={(v) => { setYearSel(v); applyMonthWindow(v, monthSel); }}>
                    <SelectTrigger aria-label="سال">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="max-h-64">
                      {Array.from({ length: 6 }, (_, i) => todayJ.jy - 5 + i).map((y) => (
                        <SelectItem key={y} value={String(y)}>{toPersianDigits(y)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </>
            ) : (
              <>
                <div className="space-y-1.5 min-w-0">
                  <Label className="text-xs text-muted-foreground">تاریخ از</Label>
                  <JalaliDateInput value={from} onChange={setFrom} placeholder="از تاریخ" />
                </div>
                <div className="space-y-1.5 min-w-0">
                  <Label className="text-xs text-muted-foreground">تاریخ تا</Label>
                  <JalaliDateInput value={to} onChange={setTo} placeholder="تا تاریخ" />
                </div>
              </>
            )}
            {isNationwide ? (
              <div className="space-y-1.5 min-w-0">
                <Label htmlFor="report-checkpoint" className="text-xs text-muted-foreground">
                  بندر
                </Label>
                <SearchSelect
                  id="report-checkpoint"
                  value={checkpointSel}
                  onChange={(v) => setCheckpointSel(v ?? ALL)}
                  options={[
                    { value: ALL, label: "همه بنادر" },
                    ...toOptions(checkpointsQuery.data?.checkpoints, (c) => c.id, (c) => c.name),
                  ]}
                  placeholder="همه بنادر"
                  searchPlaceholder="جستجوی بندر…"
                  loading={checkpointsQuery.isLoading}
                />
              </div>
            ) : (
              <div className="space-y-1.5 min-w-0">
                <Label className="text-xs text-muted-foreground">بندر</Label>
                <PortScopeChip isNationwide={false} checkpointName={user?.checkpointName} />
              </div>
            )}
            <div className="space-y-1.5 min-w-0">
              <Label htmlFor="report-group" className="text-xs text-muted-foreground">
                گروپ
              </Label>
              <SearchSelect
                id="report-group"
                value={groupSel}
                onChange={(v) => {
                  setGroupSel(v ?? ALL);
                  // The individual filter cannot contradict the group filter.
                  if (v !== ALL && importerSel !== ALL) setImporterSel(ALL);
                }}
                options={[
                  { value: ALL, label: "همه گروپ‌ها" },
                  ...toOptions(groupsQuery.data?.groups, (g) => g.id, (g) => g.name),
                ]}
                placeholder="همه گروپ‌ها"
                searchPlaceholder="جستجوی گروپ…"
                loading={groupsQuery.isLoading}
              />
            </div>
            <div className="space-y-1.5 min-w-0">
              <Label htmlFor="report-importer" className="text-xs text-muted-foreground">
                واردکننده (فردی)
              </Label>
              <SearchSelect
                id="report-importer"
                value={importerSel}
                onChange={(v) => setImporterSel(v ?? ALL)}
                options={[
                  { value: ALL, label: "همه واردکنندگان" },
                  ...toOptions(importersQuery.data?.importers, (im) => im.id, (im) => im.name),
                ]}
                placeholder={groupSel !== ALL ? "همه اعضای گروپ" : "همه واردکنندگان"}
                searchPlaceholder="جستجوی واردکننده…"
                loading={importersQuery.isLoading}
              />
            </div>
            <div className="space-y-1.5 min-w-0">
              <Label htmlFor="report-item" className="text-xs text-muted-foreground">
                جنس
              </Label>
              <SearchSelect
                id="report-item"
                value={itemSel}
                onChange={(v) => setItemSel(v ?? ALL)}
                options={[
                  { value: ALL, label: "همه اجناس" },
                  ...toOptions(itemsQuery.data?.items, (it) => it.id, (it) => it.name),
                ]}
                placeholder="همه اجناس"
                searchPlaceholder="جستجوی جنس…"
                loading={itemsQuery.isLoading}
              />
            </div>
            <div className="space-y-1.5 min-w-0">
              <Label className="text-xs text-muted-foreground" htmlFor="report-search">
                جستجو
              </Label>
              <Input
                id="report-search"
                value={qInput}
                onChange={(e) => setQInput(e.target.value)}
                placeholder="جستجو (نمبر ثبت / ملاحظات)"
              />
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button onClick={handleShow} disabled={isFetching}>
              {isFetching ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Table2 className="size-4" aria-hidden />
              )}
              نمایش گزارش
            </Button>
            <Button
              variant="outline"
              onClick={handleExcel}
              disabled={isFetching || exportingExcel}
            >
              {exportingExcel ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <FileSpreadsheet className="size-4" aria-hidden />
              )}
              خروجی اکسل
            </Button>
            <Button variant="outline" onClick={handlePdf} disabled={isFetching || exportingPdf}>
              {exportingPdf ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <FileDown className="size-4" aria-hidden />
              )}
              خروجی PDF
            </Button>
            <Button variant="outline" onClick={handlePrint}>
              <Printer className="size-4" aria-hidden />
              چاپ
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Error state (only when no report data is available) */}
      {reportQuery.isError && !report ? (
        <Card className="rounded-xl border-danger/30 bg-danger-soft">
          <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
            <AlertCircle className="size-8 text-danger" aria-hidden />
            <div className="text-sm font-medium text-danger">
              خطا در بارگذاری گزارش:{" "}
              {reportQuery.error instanceof Error
                ? reportQuery.error.message
                : "خطای ناشناخته"}
            </div>
            <Button variant="outline" size="sm" onClick={() => reportQuery.refetch()}>
              تلاش دوباره
            </Button>
          </CardContent>
        </Card>
      ) : reportQuery.isFetching && !report ? (
        /* Loading state */
        <Card className="rounded-xl">
          <CardContent className="p-0">
            <TableSkeleton rows={8} cols={6} />
          </CardContent>
        </Card>
      ) : !report ? (
        /* Idle state — no report generated yet */
        <Card className="rounded-xl">
          <CardContent className="p-0">
            <EmptyState
              icon={<FileX className="size-10 text-muted-foreground/50" aria-hidden />}
              title="گزارش مورد نظر را انتخاب و نمایش دهید"
              description="نوع گزارش و فیلترها را از کارگاه بالا تعیین کنید و روی «نمایش گزارش» کلیک کنید."
            />
          </CardContent>
        </Card>
      ) : (
        /* Results — entire block is the printable area */
        <div
          id="report-print-area"
          className="print-area rounded-xl border bg-card p-4 shadow-sm sm:p-6"
        >
          {/* Report header (screen + print) */}
          <div className="flex justify-center">
            <BrandLogo size={56} />
          </div>
          <h2 className="mt-3 text-center text-lg font-bold text-primary">{report.title}</h2>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 border-b border-border pb-3 text-xs text-muted-foreground">
            {metaChips.map((chip, i) => (
              <span key={i}>{chip}</span>
            ))}
          </div>

          {/* Summary — neutral chips */}
          {report.summary.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {report.summary.map((s, i) => (
                <span
                  key={`${s.label}-${i}`}
                  className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 text-xs"
                >
                  <span className="text-muted-foreground">{s.label}:</span>
                  <span className="font-bold tabular-nums text-foreground">
                    {summaryValue(s.value)}
                  </span>
                </span>
              ))}
            </div>
          )}

          {/* Data table */}
          <div
            data-report-table-scroll
            className="mt-4 max-h-[60vh] overflow-x-auto overflow-y-auto rounded-md border border-border print:max-h-none print:overflow-visible"
          >
            {report.rows.length === 0 ? (
              <EmptyState
                icon={<FileX className="size-10 text-muted-foreground/50" aria-hidden />}
                title="داده‌ای برای نمایش وجود ندارد"
              />
            ) : (
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-muted">
                  <TableRow className="border-border hover:bg-transparent">
                    {report.columns.map((col) => (
                      <TableHead
                        key={col.key}
                        className={cn(
                          "text-start text-xs sm:text-sm",
                          col.type === "number" && "text-start tabular-nums"
                        )}
                      >
                        {col.label}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paging.paged.map((row, ri) => (
                    <TableRow
                      key={ri}
                      className="border-border odd:bg-muted/40 hover:bg-muted/70"
                    >
                      {report.columns.map((col) => {
                        const v = row[col.key];
                        const text =
                          col.type === "number" && typeof v === "number"
                            ? formatNumber(v)
                            : v === null || v === undefined || v === ""
                              ? "—"
                              : String(v);
                        return (
                          <TableCell
                            key={col.key}
                            className={cn(
                              "whitespace-normal break-words text-xs sm:text-sm",
                              col.type === "number" && "text-start tabular-nums"
                            )}
                          >
                            {text}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>

          {/* Pagination — page snapshot only; totals above use ALL matching records */}
          <div className="mt-3 no-print">
            <TablePagination
              page={paging.page}
              pageCount={paging.pageCount}
              total={paging.total}
              onPage={paging.setPage}
              entityLabel="سطر"
            />
          </div>

          {/* Footer line (inside print area) */}
          <div className="mt-4 flex flex-col gap-1 border-t border-border pt-2 text-[11px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <span>سیستم کنترل واردات مرزی — شرکت نفت و گاز افغانستان (AOGC)</span>
            <span>صفحه چاپ‌شده در: {formatJalaliDateTime(new Date())}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// Named export as well, so both `import ReportsView from ...` and
// `import { ReportsView } from ...` work (page.tsx uses the named form).
export { ReportsView };
