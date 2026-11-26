"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { motion, type Variants } from "framer-motion";
import {
  ArrowLeft,
  Ban,
  Boxes,
  CalendarRange,
  Check,
  CheckCircle2,
  ClipboardList,
  Clock,
  Filter,
  Gauge,
  History,
  Inbox,
  LogIn,
  RefreshCw,
  RotateCcw,
  Send,
  Ship,
  ShieldAlert,
  SquarePen,
  TrendingUp,
  Truck,
  Undo2,
  Users,
  X,
  XCircle,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as ReTooltip,
} from "recharts";
import {
  EmptyState,
  EntryStatusBadge,
  JalaliDateInput,
  PageHeader,
  PortScopeChip,
  QuotaPill,
  TableShell,
  TableSkeleton,
} from "@/components/shared";
import { SearchSelect, toOptions } from "@/components/ui/search-select";
import { apiFetch } from "@/lib/client-api";
import { cn } from "@/lib/utils";
import {
  formatJalali,
  formatJalaliDateTime,
  formatNumber,
  formatTime,
  toPersianDigits,
} from "@/lib/jalali";
import { ACTION_LABELS, PERIOD_LABELS } from "@/lib/constants";
import { breadcrumbItems } from "@/lib/nav";
import { useAppStore } from "@/store/app-store";

// ============================================================
// Design language — restrained AOGC enterprise:
// deep teal + white + gold accents + soft semantic tints.
// Monochrome teal ramps for charts, no rainbow palettes.
// ============================================================

const C = {
  teal: "#005963",
  slate: "#94A3B8",
  grid: "#E2E8F0",
  tick: "#64748B",
  danger: "#B91C1C",
};

/** Monochrome teal ramp — ports donut + avatar accents (no rainbow). */
const TEAL_RAMP = [
  "#005963",
  "#2E7E86",
  "#5C9EA5",
  "#8FBFC4",
  "#C0DCE0",
  "#003840",
  "#77AEB4",
  "#4A929A",
];

// ============================================================
// Motion presets — transform/opacity only, restrained stagger.
// ============================================================

const staggerParent: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04, delayChildren: 0.02 } },
};

const riseItem: Variants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: "easeOut" } },
};

// ============================================================
// API payload contract — MUST stay compatible with /api/dashboard.
// allowedPerMember / memberCount are optional display extras that
// the API already returns for GROUP quotas.
// ============================================================

interface QuotaAlert {
  id: number;
  ownerType: string;
  owner: string;
  port: string;
  uom: string;
  periodType: string;
  allowed: number;
  /** GROUP only: per-member allowance (the pool = per-member × members). */
  allowedPerMember?: number | null;
  /** GROUP only: number of active members sharing the pool. */
  memberCount?: number | null;
  approved: number;
  remaining: number;
  percent: number;
  status: "ok" | "near" | "exhausted" | "exceeded";
}

interface DashboardData {
  stats: {
    todayEntries: number;
    approvedCount: number;
    reversedCount: number;
    draftCount: number;
    importersCount: number;
    activePortsCount: number;
    activeQuotas: number;
    individualQuotas: number;
    groupQuotas: number;
    nearLimitQuotas: number;
    completedLimits: number;
    importedByUom: { name: string; symbol: string; total: number }[];
  };
  dateWindow: { from: string; to: string };
  range: { from: string; to: string; label: string };
  recentEntries: {
    id: number;
    entryNumber: string;
    importDatetime: string;
    status: string;
    importerName: string;
    companyName: string | null;
    checkpointName: string;
    createdBy: string;
    items: { itemName: string; quantity: number; uom: string }[];
  }[];
  checkpointBreakdown: { name: string; count: number }[];
  statusCounts: Record<string, number>;
  membership: { groupEntries: number; individualEntries: number };
  groupsCount: number;
  trend: { label: string; approved: number; total: number }[];
  topItems: { name: string; count: number }[];
  topImporters: {
    name: string;
    companyName: string | null;
    count: number;
    lastImportDate: string | null;
    lastPort: string | null;
  }[];
  quotaAlerts: QuotaAlert[];
  recentActivity: {
    id: number;
    actionType: string;
    remarks: string | null;
    actor: string;
    entryNumber: string;
    actionAt: string;
  }[];
  lastUpdated: string;
}

// ============================================================
// Small local building blocks
// ============================================================

type StatTone = "primary" | "success" | "warning" | "danger" | "neutral";

const STAT_TONES: Record<StatTone, { chip: string; value: string }> = {
  primary: { chip: "bg-secondary text-primary", value: "text-foreground" },
  success: { chip: "bg-success-soft text-success", value: "text-success" },
  warning: { chip: "bg-warning-soft text-warning", value: "text-warning" },
  danger: { chip: "bg-danger-soft text-danger", value: "text-danger" },
  neutral: { chip: "bg-muted text-muted-foreground", value: "text-foreground" },
};

/** Hero KPI card — tinted icon chip, big Persian number, hover lift. */
function StatCard({
  label,
  value,
  icon,
  tone = "primary",
  hint,
  onClick,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  tone?: StatTone;
  hint: string;
  onClick?: () => void;
}) {
  const t = STAT_TONES[tone];
  const body = (
    <>
      <div className="flex w-full items-start justify-between gap-2">
        <span className={cn("grid size-10 shrink-0 place-items-center rounded-lg", t.chip)} aria-hidden>
          {icon}
        </span>
        {onClick && (
          <ArrowLeft
            className="size-4 translate-x-1 text-muted-foreground opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100"
            aria-hidden
          />
        )}
      </div>
      <div className={cn("text-2xl font-bold leading-none tabular-nums sm:text-3xl", t.value)}>
        {formatNumber(value)}
      </div>
      <div className="text-xs font-medium text-foreground/80">{label}</div>
      <div className="text-[11px] leading-4 text-muted-foreground">{hint}</div>
    </>
  );
  const cls =
    "group flex w-full flex-col items-start gap-2.5 rounded-xl border bg-card p-4 text-start shadow-xs";
  if (onClick) {
    return (
      <motion.button
        type="button"
        onClick={onClick}
        variants={riseItem}
        whileHover={{ y: -3 }}
        whileTap={{ scale: 0.99 }}
        className={cn(
          cls,
          "cursor-pointer transition-shadow hover:border-primary/30 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        )}
        aria-label={`${label} — مشاهده جزئیات`}
      >
        {body}
      </motion.button>
    );
  }
  return <motion.div variants={riseItem} className={cls}>{body}</motion.div>;
}

/** Compact secondary stat — strip card under the hero row. */
function StatChip({
  label,
  value,
  icon,
  tone = "primary",
  hint,
  onClick,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  tone?: StatTone;
  hint: string;
  onClick?: () => void;
}) {
  const t = STAT_TONES[tone];
  const body = (
    <>
      <div className="flex items-center gap-2.5">
        <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg", t.chip)} aria-hidden>
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] font-medium text-muted-foreground">{label}</div>
          <div className={cn("text-xl font-bold leading-tight tabular-nums", t.value)}>
            {formatNumber(value)}
          </div>
        </div>
      </div>
      <div className="mt-2 text-[10px] leading-4 text-muted-foreground">{hint}</div>
    </>
  );
  const cls = "block w-full rounded-xl border bg-card p-3 text-start shadow-xs";
  if (onClick) {
    return (
      <motion.button
        type="button"
        onClick={onClick}
        variants={riseItem}
        whileHover={{ y: -2 }}
        whileTap={{ scale: 0.99 }}
        className={cn(
          cls,
          "cursor-pointer transition-shadow hover:border-primary/30 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        )}
        aria-label={`${label} — مشاهده جزئیات`}
      >
        {body}
      </motion.button>
    );
  }
  return <motion.div variants={riseItem} className={cls}>{body}</motion.div>;
}

/** Section container — header strip with icon chip + optional subtitle/action. */
function SectionCard({
  icon,
  title,
  subtitle,
  action,
  children,
  className,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <motion.section
      variants={riseItem}
      aria-label={title}
      className={cn("overflow-hidden rounded-xl border bg-card shadow-xs", className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b bg-muted/40 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className="grid size-8 shrink-0 place-items-center rounded-lg bg-secondary text-primary"
            aria-hidden
          >
            {icon}
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
            {subtitle && (
              <p className="truncate text-[11px] text-muted-foreground">{subtitle}</p>
            )}
          </div>
        </div>
        {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
      </div>
      <div className="p-4">{children}</div>
    </motion.section>
  );
}

/** Segmented control for the trend window (۷ / ۳۰ / ۹۰ روز). */
function DaysSegmented({
  days,
  onChange,
}: {
  days: 7 | 30 | 90;
  onChange: (d: 7 | 30 | 90) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="بازه زمانی روند واردات"
      className="inline-flex items-center gap-0.5 rounded-lg border bg-muted p-0.5"
    >
      {([7, 30, 90] as const).map((d) => {
        const active = days === d;
        return (
          <button
            key={d}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(d)}
            className={cn(
              "h-9 min-w-11 rounded-md px-2 text-xs font-medium transition-colors",
              active
                ? "bg-card text-primary shadow-xs"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {toPersianDigits(d)} روز
          </button>
        );
      })}
    </div>
  );
}

/** Chart legend chip — colored dot + Dari label. */
function LegendChip({
  color,
  dashed,
  label,
}: {
  color: string;
  dashed?: boolean;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
      {dashed ? (
        <span
          aria-hidden
          className="h-0.5 w-4 rounded-full"
          style={{
            backgroundImage: `repeating-linear-gradient(to left, ${color} 0 4px, transparent 4px 7px)`,
          }}
        />
      ) : (
        <span aria-hidden className="size-2.5 rounded-full" style={{ background: color }} />
      )}
      {label}
    </span>
  );
}

/** ۱۴۰۴/۰۷/۱۵ → ۰۷/۱۵ for a compact axis. */
function trendTick(value: string) {
  const parts = value.split("/");
  return parts.length === 3 ? `${parts[1]}/${parts[2]}` : value;
}

function itemsSummary(items: { itemName: string; quantity: number; uom: string }[]) {
  return items.length
    ? items.map((i) => `${i.itemName} ${formatNumber(i.quantity)} ${i.uom}`).join(" · ")
    : "—";
}

/** GROUP owners arrive as "گروپ: نام" — strip the prefix; the badge shows type. */
function ownerDisplayName(a: QuotaAlert) {
  return a.ownerType === "GROUP" ? a.owner.replace(/^گروپ:\s*/, "") : a.owner;
}

function OwnerMiniBadge({ ownerType }: { ownerType: string }) {
  const isGroup = ownerType === "GROUP";
  return (
    <span
      className={cn(
        "shrink-0 rounded border px-1 py-px text-[10px] leading-4",
        isGroup
          ? "border-primary/30 bg-primary/10 text-primary"
          : "border-border bg-muted text-muted-foreground"
      )}
    >
      {isGroup ? "گروپی" : "فردی"}
    </span>
  );
}

// ============================================================
// Chart tooltips — rounded, RTL, Persian digits
// ============================================================

function DonutTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { name?: string; value?: number }[];
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  return (
    <div className="rounded-xl border bg-popover px-3 py-2 text-xs shadow-lg" dir="rtl">
      <span className="font-medium">{p.name}</span>
      {": "}
      <span className="font-bold tabular-nums">{toPersianDigits(p.value ?? 0)}</span>
    </div>
  );
}

function TrendTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { dataKey?: string | number; value?: number | string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const row = (k: string) => {
    const found = payload.find((p) => p.dataKey === k);
    return Number(found?.value ?? 0);
  };
  return (
    <div dir="rtl" className="min-w-36 space-y-1 rounded-xl border bg-popover px-3 py-2 text-xs shadow-lg">
      <div className="font-medium text-foreground">تاریخ {label}</div>
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <span aria-hidden className="size-2 rounded-full" style={{ background: C.teal }} />
        تأییدشده: <span className="font-bold text-foreground tabular-nums">{toPersianDigits(row("approved"))}</span>
      </div>
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <span aria-hidden className="size-2 rounded-full" style={{ background: C.slate }} />
        مجموع ثبت‌ها: <span className="font-bold text-foreground tabular-nums">{toPersianDigits(row("total"))}</span>
      </div>
    </div>
  );
}

// ============================================================
// Quota rows — alert list + utilization progress bars
// ============================================================

const QUOTA_DOT: Record<QuotaAlert["status"], string> = {
  ok: "bg-success",
  near: "bg-warning",
  exhausted: "bg-danger",
  exceeded: "bg-danger animate-pulse",
};

const QUOTA_FILL: Record<QuotaAlert["status"], string> = {
  ok: C.teal,
  near: "#b45309",
  exhausted: C.slate,
  exceeded: C.danger,
};

const QUOTA_CHIP: Record<QuotaAlert["status"], string> = {
  ok: "border-success/30 bg-success-soft text-success",
  near: "border-warning/30 bg-warning-soft text-warning",
  exhausted: "border-danger/30 bg-danger-soft text-danger",
  exceeded: "border-danger bg-danger text-white",
};

/** Group-per-member meta line — shown only for GROUP quotas. */
function GroupMemberMeta({ a }: { a: QuotaAlert }) {
  if (a.ownerType !== "GROUP" || a.allowedPerMember == null || !a.memberCount) return null;
  return (
    <div className="truncate text-[11px] text-muted-foreground/90">
      <Users className="me-1 inline size-3 text-gold" aria-hidden />
      سهم هر عضو: {formatNumber(a.allowedPerMember)} {a.uom} · {toPersianDigits(a.memberCount)} عضو فعال
    </div>
  );
}

function QuotaAlertRow({ a }: { a: QuotaAlert }) {
  const tone =
    a.status === "exceeded" || a.status === "exhausted"
      ? "danger"
      : a.status === "near"
        ? "warn"
        : "ok";
  const pillLabel =
    a.status === "exceeded" ? "بیش از حد" : a.status === "exhausted" ? "تکمیل‌شده" : "استفاده";
  return (
    <div className="flex items-center gap-3 rounded-lg border p-2.5 transition-colors hover:border-primary/30 hover:bg-secondary/40">
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", QUOTA_DOT[a.status])} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          {a.ownerType === "GROUP" && <Users className="size-3 shrink-0 text-gold" aria-hidden />}
          <span className="truncate text-xs font-medium" title={a.owner}>
            {ownerDisplayName(a)}
          </span>
          <OwnerMiniBadge ownerType={a.ownerType} />
        </div>
        <div className="truncate text-[11px] text-muted-foreground">
          {a.port} · {PERIOD_LABELS[a.periodType] ?? a.periodType} · باقی‌مانده{" "}
          {formatNumber(a.remaining)} {a.uom}
        </div>
        <GroupMemberMeta a={a} />
      </div>
      <QuotaPill
        label={pillLabel}
        value={`${toPersianDigits(Math.round(a.percent))}٪`}
        tone={tone}
      />
    </div>
  );
}

function QuotaUtilizationRow({ a }: { a: QuotaAlert }) {
  const width = Math.min(100, Math.max(0, a.percent));
  return (
    <div className="space-y-2 rounded-lg border p-2.5 transition-colors hover:border-primary/30 hover:bg-secondary/30">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {a.ownerType === "GROUP" && <Users className="size-3 shrink-0 text-gold" aria-hidden />}
          <span className="truncate text-xs font-medium" title={a.owner}>
            {ownerDisplayName(a)}
          </span>
          <OwnerMiniBadge ownerType={a.ownerType} />
        </div>
        <span
          className={cn(
            "shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] font-bold tabular-nums",
            QUOTA_CHIP[a.status]
          )}
        >
          {toPersianDigits(Math.round(a.percent))}٪
        </span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={Math.round(a.percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`درصد استفاده ${ownerDisplayName(a)}`}
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${width}%`, background: QUOTA_FILL[a.status] }}
        />
      </div>
      <div className="truncate text-[11px] text-muted-foreground">
        {a.port} · {PERIOD_LABELS[a.periodType] ?? a.periodType} · استفاده {formatNumber(a.approved)}{" "}
        از {formatNumber(a.allowed)} {a.uom} · باقی‌مانده {formatNumber(a.remaining)} {a.uom}
      </div>
      <GroupMemberMeta a={a} />
    </div>
  );
}

// ============================================================
// Recent activity — vertical timeline with action-toned dots
// ============================================================

function activityVisual(actionType: string): { cls: string; icon: React.ReactNode } {
  switch (actionType) {
    case "APPROVE":
    case "EXCEPTION_APPROVE":
      return { cls: "border-success/30 bg-success-soft text-success", icon: <Check className="size-3.5" /> };
    case "REJECT":
    case "EXCEPTION_REJECT":
      return { cls: "border-danger/30 bg-danger-soft text-danger", icon: <XCircle className="size-3.5" /> };
    case "REVERSE":
      return { cls: "border-warning/30 bg-warning-soft text-warning", icon: <Undo2 className="size-3.5" /> };
    case "CREATE":
      return { cls: "border-primary/20 bg-secondary text-primary", icon: <SquarePen className="size-3.5" /> };
    case "SUBMIT":
    case "FINALIZE":
      return { cls: "border-primary/20 bg-secondary text-primary", icon: <Send className="size-3.5" /> };
    case "LOGIN":
      return { cls: "border-border bg-muted text-muted-foreground", icon: <LogIn className="size-3.5" /> };
    default:
      return { cls: "border-border bg-muted text-muted-foreground", icon: <History className="size-3.5" /> };
  }
}

function ActivityTimeline({
  activity,
}: {
  activity: DashboardData["recentActivity"];
}) {
  return (
    <ol className="space-y-3">
      {activity.map((a, i) => {
        const v = activityVisual(a.actionType);
        return (
          <li key={a.id} className="relative flex gap-3">
            {i < activity.length - 1 && (
              <span
                aria-hidden
                className="absolute -bottom-3 start-[15px] top-8 w-px bg-border"
              />
            )}
            <span
              aria-hidden
              className={cn(
                "relative z-10 grid size-8 shrink-0 place-items-center rounded-full border",
                v.cls
              )}
            >
              {v.icon}
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="text-xs font-medium leading-5">
                {ACTION_LABELS[a.actionType] ?? a.actionType}
                <span className="font-normal text-muted-foreground"> — {a.actor}</span>
              </div>
              <div className="truncate text-[11px] text-muted-foreground">
                <span className="font-mono" dir="ltr">
                  {a.entryNumber}
                </span>
                {a.actionAt ? ` · ${formatJalaliDateTime(a.actionAt)}` : ""}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ============================================================
// Loading skeleton — mirrors the new layout
// ============================================================

function SkeletonCard({ className }: { className?: string }) {
  return (
    <div className={cn("rounded-xl border bg-card p-4", className)}>
      <div className="flex items-center gap-2.5">
        <div className="size-10 animate-pulse rounded-lg bg-muted" />
        <div className="flex-1 space-y-2">
          <div className="h-3.5 w-2/3 animate-pulse rounded bg-muted" />
          <div className="h-5 w-1/3 animate-pulse rounded bg-muted" />
        </div>
      </div>
      <div className="mt-3 h-3 w-4/5 animate-pulse rounded bg-muted" />
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-4" aria-hidden role="presentation">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} className="p-3" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="overflow-hidden rounded-xl border bg-card">
            <div className="border-b bg-muted/40 px-4 py-3">
              <div className="h-4 w-40 animate-pulse rounded bg-muted" />
            </div>
            <TableSkeleton rows={5} cols={5} />
          </div>
        ))}
      </div>
      <TableShell maxHeight="340px">
        <TableSkeleton rows={6} cols={6} />
      </TableShell>
    </div>
  );
}

// ============================================================
// Dashboard content — rendered once data is available
// ============================================================

function DashboardContent({
  data,
  role,
  days,
  onDaysChange,
  from,
  to,
}: {
  data: DashboardData;
  role: string;
  days: 7 | 30 | 90;
  onDaysChange: (d: 7 | 30 | 90) => void;
  from: string | null;
  to: string | null;
}) {
  const setView = useAppStore((s) => s.setView);
  const isNationwide = role === "ADMIN";
  const scopeHint = isNationwide ? "تمام بنادر" : "بندر مسئولیت شما";

  const alerts = data.quotaAlerts;
  const alertRows = alerts.filter((a) => a.status !== "ok");
  const exceededAny = alerts.some((a) => a.status === "exceeded");
  const portsData = data.checkpointBreakdown.filter((b) => b.count > 0);
  const donutTotal = portsData.reduce((s, b) => s + b.count, 0);
  const utilization = [...alerts]
    .sort((a, b) => b.percent - a.percent)
    .slice(0, 8);
  const activity = data.recentActivity.slice(0, 8);
  const recentEntries = data.recentEntries;
  const hasCustomRange = Boolean(from || to);
  const analyticsHint = hasCustomRange
    ? "در بازه تاریخ انتخابی"
    : `${toPersianDigits(days)} روز اخیر`;

  // ---------- Composition analytics ----------
  const sc = data.statusCounts ?? {};
  const statusTotal = (sc.APPROVED ?? 0) + (sc.DRAFT ?? 0) + (sc.REVERSED ?? 0);
  const statusData = [
    { key: "APPROVED", name: "ثبت‌شده", value: sc.APPROVED ?? 0, color: C.teal },
    { key: "DRAFT", name: "مسوده", value: sc.DRAFT ?? 0, color: C.slate },
    { key: "REVERSED", name: "ابطال‌شده", value: sc.REVERSED ?? 0, color: C.danger },
  ].filter((s) => s.value > 0);
  const membershipTotal = data.membership.groupEntries + data.membership.individualEntries;
  const membershipData = [
    { name: "اعضای گروپ‌ها", value: data.membership.groupEntries, color: C.teal },
    { name: "واردکنندگان انفرادی", value: data.membership.individualEntries, color: C.slate },
  ].filter((m) => m.value > 0);
  // Average approved entries per active day within the trend window.
  const activeDays = data.trend.filter((t) => t.approved > 0).length;
  const trendApprovedSum = data.trend.reduce((s, t) => s + t.approved, 0);
  const avgPerActiveDay = activeDays > 0 ? trendApprovedSum / activeDays : 0;
  const busiestDay = data.trend.reduce<{ label: string; approved: number } | null>(
    (best, t) => (!best || t.approved > best.approved ? { label: t.label, approved: t.approved } : best),
    null
  );
  const topItemsMax = Math.max(...data.topItems.map((t) => t.count), 1);

  return (
    <motion.div variants={staggerParent} initial="hidden" animate="show" className="space-y-4">
      {/* ---------- 2. Hero KPI row ---------- */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="ثبت‌های امروز"
          value={data.stats.todayEntries}
          icon={<ClipboardList className="size-5" />}
          tone="primary"
          hint="واردات ثبت‌شده امروز (به وقت کابل)"
          onClick={() => setView("entries")}
        />
        <StatCard
          label="ثبت‌شده (در بازه)"
          value={data.stats.approvedCount}
          icon={<CheckCircle2 className="size-5" />}
          tone="success"
          hint={hasCustomRange ? "در بازه تاریخ انتخابی" : "امروز (به وقت کابل)"}
        />
        <StatCard
          label="مسوده‌های باز"
          value={data.stats.draftCount}
          icon={<SquarePen className="size-5" />}
          tone={data.stats.draftCount > 0 ? "warning" : "neutral"}
          hint={`${scopeHint} — برای تکمیل آماده`}
          onClick={() => setView("entries")}
        />
        <StatCard
          label={isNationwide ? "واردکنندگان فعال" : "واردکنندگان فعال بندر"}
          value={data.stats.importersCount}
          icon={<Truck className="size-5" />}
          tone="primary"
          hint={isNationwide ? "در سراسر کشور" : "با فعالیت در بندر مسئولیت شما"}
        />
      </div>

      {/* ---------- 2b. Secondary stat strip ---------- */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatChip
          label="ابطال‌شده"
          value={data.stats.reversedCount}
          icon={<XCircle className="size-4" />}
          tone={data.stats.reversedCount > 0 ? "danger" : "neutral"}
          hint={`${scopeHint} — بدون محدودیت تاریخ`}
        />
        <StatChip
          label="سهمیه‌های فعال"
          value={data.stats.activeQuotas}
          icon={<Gauge className="size-4" />}
          hint={`فردی: ${toPersianDigits(data.stats.individualQuotas)} · گروپی: ${toPersianDigits(data.stats.groupQuotas)}`}
          onClick={() => setView("limits-review")}
        />
        <StatChip
          label="سهمیه‌های نزدیک به حد"
          value={data.stats.nearLimitQuotas}
          icon={<ShieldAlert className="size-4" />}
          tone={exceededAny ? "danger" : data.stats.nearLimitQuotas > 0 ? "warning" : "neutral"}
          hint="بالای آستانه هشدار استفاده‌شده"
          onClick={() => setView("limits-review")}
        />
        <StatChip
          label="سهمیه‌های تکمیل‌شده"
          value={data.stats.completedLimits}
          icon={<Ban className="size-4" />}
          tone={data.stats.completedLimits > 0 ? "danger" : "neutral"}
          hint="موجودی تمام یا بیش از حد مصرف شده — ثبت جدید مسدود است"
          onClick={() => setView("limits-review")}
        />
      </div>

      {/* ---------- 3. Attention row — quota alerts ---------- */}
      <SectionCard
        icon={<ShieldAlert className="size-4" />}
        title="سهمیه‌های در وضعیت هشدار"
        action={
          alerts.length > 0 ? (
            <span className="text-[11px] text-muted-foreground">
              فردی {toPersianDigits(alerts.filter((x) => x.ownerType !== "GROUP").length)} · گروپی{" "}
              {toPersianDigits(alerts.filter((x) => x.ownerType === "GROUP").length)}
              {alertRows.length > 0 && (
                <span className="ms-2 rounded-full bg-warning-soft px-2 py-0.5 font-bold text-warning">
                  {toPersianDigits(alertRows.length)} مورد هشدار
                </span>
              )}
            </span>
          ) : undefined
        }
      >
        {alertRows.length === 0 ? (
          <EmptyState
            icon={<ShieldAlert className="size-5" />}
            title="هیچ هشدار سهمیه‌ای موجود نیست."
            description="همه سهمیه‌های فعال در وضعیت طبیعی قرار دارند."
          />
        ) : (
          <>
            <div className="space-y-2">
              {alertRows.slice(0, 6).map((a) => (
                <QuotaAlertRow key={a.id} a={a} />
              ))}
            </div>
            <div>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs text-primary hover:bg-secondary"
                onClick={() => setView("limits-review")}
              >
                مشاهده همه
                <ArrowLeft className="size-3.5" aria-hidden />
              </Button>
            </div>
          </>
        )}
      </SectionCard>

      {/* ---------- 4. Import trend ---------- */}
      <SectionCard
        icon={<TrendingUp className="size-4" />}
        title="روند واردات"
        action={<DaysSegmented days={days} onChange={onDaysChange} />}
      >
        {data.trend.length === 0 ? (
          <EmptyState
            icon={<TrendingUp className="size-5" />}
            title="داده‌ای برای نمایش روند موجود نیست."
            description="در بازه انتخابی ثبت وارداتی وجود ندارد."
          />
        ) : (
          <div className="space-y-3">
            <div dir="ltr" className="h-56 w-full sm:h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data.trend} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="dashApprovedFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={C.teal} stopOpacity={0.22} />
                      <stop offset="100%" stopColor={C.teal} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.grid} vertical={false} />
                  <XAxis
                    dataKey="label"
                    tickFormatter={trendTick}
                    reversed
                    tick={{ fontSize: 11, fill: C.tick }}
                    axisLine={{ stroke: C.grid }}
                    tickLine={false}
                    minTickGap={24}
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={{ fontSize: 11, fill: C.tick }}
                    axisLine={false}
                    tickLine={false}
                    width={36}
                    tickFormatter={(v: number) => toPersianDigits(v)}
                  />
                  <ReTooltip
                    content={<TrendTooltip />}
                    cursor={{ stroke: C.slate, strokeWidth: 1, strokeDasharray: "3 3" }}
                  />
                  <Area
                    type="monotone"
                    dataKey="total"
                    stroke={C.slate}
                    strokeDasharray="4 3"
                    fill="transparent"
                    strokeWidth={1.5}
                    dot={false}
                    activeDot={{ r: 3, fill: C.slate, strokeWidth: 0 }}
                  />
                  <Area
                    type="monotone"
                    dataKey="approved"
                    stroke={C.teal}
                    strokeWidth={2.5}
                    fill="url(#dashApprovedFill)"
                    dot={false}
                    activeDot={{ r: 4, fill: C.teal, stroke: "#ffffff", strokeWidth: 2 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
              <LegendChip color={C.teal} label="تأییدشده" />
              <LegendChip color={C.slate} dashed label="مجموع ثبت‌ها" />
              <span className="ms-auto text-[11px] text-muted-foreground">
                مجموع <span className="font-bold text-foreground tabular-nums">{toPersianDigits(trendApprovedSum)}</span>{" "}
                ثبت در{" "}
                <span className="font-bold text-foreground tabular-nums">{toPersianDigits(activeDays)}</span>{" "}
                روز فعال
              </span>
            </div>
            <div className="text-[11px] text-muted-foreground">
              خط پررنگ: تأییدشده — خط نقطه‌چین: مجموع ثبت‌ها. محور زمان از راست به چپ خوانده
              می‌شود.
            </div>
          </div>
        )}
      </SectionCard>

      {/* ---------- 4b. Top items + status composition ---------- */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SectionCard
          icon={<Boxes className="size-4" />}
          title="اجناس با بیشترین واردات"
          subtitle={analyticsHint}
        >
          {data.topItems.length === 0 ? (
            <EmptyState
              icon={<Boxes className="size-5" />}
              title="داده‌ای برای نمایش موجود نیست."
              description="با ثبت واردات، اجناس پرتکرار اینجا رتبه‌بندی می‌شوند."
            />
          ) : (
            <div className="space-y-3">
              <div className="space-y-2.5">
                {data.topItems.map((t, i) => (
                  <div
                    key={t.name}
                    className="group rounded-lg p-1.5 transition-colors hover:bg-muted/50"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className={cn(
                            "grid size-5 shrink-0 place-items-center rounded-md text-[10px] font-bold tabular-nums",
                            i === 0
                              ? "border border-gold/50 bg-gold/15 text-primary"
                              : "bg-muted text-muted-foreground"
                          )}
                          aria-hidden
                        >
                          {toPersianDigits(i + 1)}
                        </span>
                        <span className="truncate text-xs font-medium" title={t.name}>
                          {t.name}
                        </span>
                      </div>
                      <span className="shrink-0 rounded-md border border-primary/20 bg-secondary px-1.5 py-0.5 text-[11px] font-bold text-primary tabular-nums">
                        {toPersianDigits(t.count)} ثبت
                      </span>
                    </div>
                    <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary transition-colors group-hover:bg-primary/80"
                        style={{ width: `${(t.count / topItemsMax) * 100}%`, opacity: 0.55 + 0.45 * (t.count / topItemsMax) }}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <div className="text-[11px] text-muted-foreground">
                تعداد ثبت‌های تأییدشده به تفکیک جنس در بازه — مقادیر با واحدهای متفاوت جمع نمی‌شوند.
              </div>
            </div>
          )}
        </SectionCard>

        <SectionCard
          icon={<ClipboardList className="size-4" />}
          title="ترکیب وضعیت ثبت‌ها"
          subtitle={analyticsHint}
        >
          {statusTotal === 0 ? (
            <EmptyState
              icon={<ClipboardList className="size-5" />}
              title="ثبتی در این بازه موجود نیست."
              description="پس از ثبت واردات، ترکیب وضعیت‌ها اینجا نمایش داده می‌شود."
            />
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-4">
                <div dir="ltr" className="relative h-40 w-40 shrink-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={statusData}
                        dataKey="value"
                        nameKey="name"
                        innerRadius="66%"
                        outerRadius="90%"
                        paddingAngle={3}
                        cornerRadius={6}
                        strokeWidth={0}
                      >
                        {statusData.map((s) => (
                          <Cell key={s.key} fill={s.color} />
                        ))}
                      </Pie>
                      <ReTooltip content={<DonutTooltip />} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="pointer-events-none absolute inset-0 grid place-items-center">
                    <div className="text-center">
                      <div className="text-xl font-bold tabular-nums">{toPersianDigits(statusTotal)}</div>
                      <div className="text-[10px] text-muted-foreground">مجموع ثبت</div>
                    </div>
                  </div>
                </div>
                <div className="min-w-0 flex-1 space-y-1.5">
                  {statusData.map((s) => (
                    <div key={s.key} className="flex min-w-0 items-center gap-2 text-xs">
                      <span className="size-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
                      <span className="flex-1 truncate text-muted-foreground">{s.name}</span>
                      <span className="font-bold tabular-nums">{toPersianDigits(s.value)}</span>
                      <span className="w-9 shrink-0 text-end text-[10px] text-muted-foreground tabular-nums">
                        {toPersianDigits(Math.round((s.value / statusTotal) * 100))}٪
                      </span>
                    </div>
                  ))}
                  <div className="mt-1 space-y-0.5 border-t pt-1.5 text-[11px] text-muted-foreground">
                    <div>
                      میانگین روزهای فعال:{" "}
                      <span className="font-bold text-foreground tabular-nums">
                        {toPersianDigits(Math.round(avgPerActiveDay * 10) / 10)}
                      </span>{" "}
                      ثبت
                    </div>
                    {busiestDay && busiestDay.approved > 0 && (
                      <div>
                        پرکارترین روز:{" "}
                        <span className="font-medium text-foreground">{busiestDay.label}</span> (
                        {toPersianDigits(busiestDay.approved)} ثبت)
                      </div>
                    )}
                  </div>
                </div>
              </div>
              {/* Membership split — group vs individual activity */}
              {membershipTotal > 0 && (
                <div className="space-y-2 rounded-lg border p-2.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium">فعالیت به تفکیک عضویت گروپ</span>
                    <span className="text-[11px] text-muted-foreground">
                      {toPersianDigits(data.groupsCount)} گروپ فعال
                    </span>
                  </div>
                  <div dir="ltr" className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
                    {membershipData.map((m) => (
                      <div
                        key={m.name}
                        className="h-full"
                        style={{ width: `${(m.value / membershipTotal) * 100}%`, background: m.color }}
                      />
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {membershipData.map((m) => (
                      <div key={m.name} className="flex min-w-0 items-center gap-1.5 text-[11px]">
                        <span className="size-2.5 shrink-0 rounded-full" style={{ background: m.color }} />
                        <span className="text-muted-foreground">{m.name}:</span>
                        <span className="font-bold tabular-nums">{toPersianDigits(m.value)}</span>
                        <span className="text-muted-foreground">
                          ({toPersianDigits(Math.round((m.value / membershipTotal) * 100))}٪)
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </SectionCard>
      </div>

      {/* ---------- 5. Utilization + ports ---------- */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SectionCard
          icon={<Gauge className="size-4" />}
          title="بالاترین استفاده از سهمیه‌ها"
          subtitle={alerts.length > 0 ? `${toPersianDigits(alerts.length)} سهمیه فعال` : undefined}
        >
          {alerts.length === 0 ? (
            <EmptyState
              icon={<Gauge className="size-5" />}
              title="هیچ سهمیه فعالی موجود نیست."
              description="پس از تعریف حد مجاز، درصد استفاده اینجا نمایش داده می‌شود."
            />
          ) : (
            <div className="space-y-3">
              <div className="space-y-2">
                {utilization.map((a) => (
                  <QuotaUtilizationRow key={a.id} a={a} />
                ))}
              </div>
              <div className="text-[11px] text-muted-foreground">
                درصد استفاده از موجودی مشترک هر حد مجاز — نوارهای سرخ از حد عبور کرده‌اند و
                خاکستری تکمیل‌شده‌اند. ثبت واردات بیش از باقی‌مانده مسدود است.
              </div>
            </div>
          )}
        </SectionCard>

        {isNationwide && (
          <SectionCard
            icon={<Ship className="size-4" />}
            title="ثبت‌های تأییدشده به اساس بندر"
          >
            {portsData.length === 0 ? (
              <EmptyState
                icon={<Ship className="size-5" />}
                title="واردات تأییدشده‌ای موجود نیست."
                description="در بازه انتخابی هیچ ثبت تأییدشده‌ای برای بنادر ثبت نشده است."
              />
            ) : (
              <div className="space-y-3">
                <div dir="ltr" className="relative h-44 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={portsData}
                        dataKey="count"
                        nameKey="name"
                        innerRadius="66%"
                        outerRadius="90%"
                        paddingAngle={3}
                        cornerRadius={6}
                        strokeWidth={0}
                      >
                        {portsData.map((d, i) => (
                          <Cell key={d.name} fill={TEAL_RAMP[i % TEAL_RAMP.length]} />
                        ))}
                      </Pie>
                      <ReTooltip content={<DonutTooltip />} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="pointer-events-none absolute inset-0 grid place-items-center">
                    <div className="text-center">
                      <div className="text-2xl font-bold tabular-nums">
                        {toPersianDigits(donutTotal)}
                      </div>
                      <div className="text-[11px] text-muted-foreground">مجموع تأییدشده</div>
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
                  {portsData.map((d, i) => (
                    <div key={d.name} className="flex min-w-0 items-center gap-2 text-xs">
                      <span
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ background: TEAL_RAMP[i % TEAL_RAMP.length] }}
                      />
                      <span className="flex-1 truncate text-muted-foreground" title={d.name}>
                        {d.name}
                      </span>
                      <span className="font-bold tabular-nums">{toPersianDigits(d.count)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </SectionCard>
        )}
      </div>

      {/* ---------- 5b. Most active importers ---------- */}
      <SectionCard
        icon={<Truck className="size-4" />}
        title="واردکنندگان فعال برتر"
        subtitle={`ثبت‌های تأییدشده — ${analyticsHint}`}
      >
        {data.topImporters.length === 0 ? (
          <EmptyState
            icon={<Truck className="size-5" />}
            title="فعالیتی برای نمایش موجود نیست."
            description="پس از ثبت واردات تأییدشده، پرکارترین واردکنندگان اینجا رتبه‌بندی می‌شوند."
          />
        ) : (
          <div className="grid grid-cols-1 gap-x-6 md:grid-cols-2">
            {data.topImporters.map((im, i) => (
              <div
                key={`${im.name}-${i}`}
                className="flex items-center gap-3 rounded-lg border-b border-border/60 px-2 py-2 transition-colors last:border-0 hover:bg-muted/50"
              >
                <span
                  className={cn(
                    "grid size-5 shrink-0 place-items-center rounded-md text-[10px] font-bold tabular-nums",
                    i === 0
                      ? "bg-gold text-primary"
                      : i < 3
                        ? "bg-secondary text-primary"
                        : "bg-muted text-muted-foreground"
                  )}
                  title={`رتبه ${toPersianDigits(i + 1)}`}
                >
                  {toPersianDigits(i + 1)}
                </span>
                <span
                  aria-hidden
                  className="grid size-9 shrink-0 place-items-center rounded-full bg-secondary text-sm font-bold text-primary"
                >
                  {im.name.trim().charAt(0) || "—"}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium" title={im.name}>
                    {im.name}
                  </div>
                  <div className="truncate text-[10px] text-muted-foreground">
                    {im.lastImportDate
                      ? `آخرین ثبت: ${formatJalaliDateTime(im.lastImportDate)}${im.lastPort ? ` — ${im.lastPort}` : ""}`
                      : "—"}
                  </div>
                </div>
                <span
                  className="shrink-0 rounded-md border border-primary/20 bg-primary/5 px-2 py-0.5 text-xs font-bold text-primary tabular-nums"
                  title="تعداد ثبت تأییدشده"
                >
                  {toPersianDigits(im.count)}
                </span>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {/* ---------- 6. Recent imports ---------- */}
      <motion.div variants={riseItem}>
        <TableShell
          maxHeight="430px"
          toolbar={
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <span
                  className="grid size-8 place-items-center rounded-lg bg-secondary text-primary"
                  aria-hidden
                >
                  <ClipboardList className="size-4" />
                </span>
                <h2 className="text-sm font-semibold text-foreground">جدیدترین ثبت‌های واردات</h2>
              </div>
              <span className="text-[11px] text-muted-foreground">
                آخرین ۶ ثبت — بدون محدودیت تاریخ
              </span>
            </div>
          }
          footer={
            <div className="border-t p-3">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs text-primary hover:bg-secondary"
                onClick={() => setView("entries")}
              >
                مشاهده همه ثبت‌ها
                <ArrowLeft className="size-3.5" aria-hidden />
              </Button>
            </div>
          }
        >
          {recentEntries.length === 0 ? (
            <EmptyState
              icon={<Inbox className="size-5" />}
              title="ثبت وارداتی موجود نیست."
              description="هنوز هیچ ثبت وارداتی در بندر(های) مسئولیت شما ثبت نشده است."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-[11px]">شماره ثبت</TableHead>
                  <TableHead className="text-[11px]">تاریخ ثبت</TableHead>
                  <TableHead className="text-[11px]">واردکننده</TableHead>
                  <TableHead className="text-[11px]">بندر</TableHead>
                  <TableHead className="text-[11px]">اقلام</TableHead>
                  <TableHead className="text-[11px]">وضعیت</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentEntries.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="font-mono text-xs whitespace-nowrap" dir="ltr">
                      {e.entryNumber}
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      {formatJalaliDateTime(e.importDatetime)}
                    </TableCell>
                    <TableCell className="max-w-40 text-xs">
                      <div className="truncate font-medium" title={e.importerName}>
                        {e.importerName}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-32 text-xs">
                      <div className="truncate" title={e.checkpointName}>
                        {e.checkpointName}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-64 text-xs">
                      <div className="flex items-center gap-1 overflow-hidden" title={itemsSummary(e.items)}>
                        {e.items.slice(0, 2).map((it, idx) => (
                          <span
                            key={idx}
                            className="inline-flex max-w-40 truncate rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                          >
                            {it.itemName} {formatNumber(it.quantity)} {it.uom}
                          </span>
                        ))}
                        {e.items.length > 2 && (
                          <span className="shrink-0 rounded-md bg-secondary px-1.5 py-0.5 text-[10px] font-bold text-primary">
                            +{toPersianDigits(e.items.length - 2)}
                          </span>
                        )}
                        {e.items.length === 0 && <span className="text-muted-foreground">—</span>}
                      </div>
                    </TableCell>
                    <TableCell>
                      <EntryStatusBadge status={e.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TableShell>
      </motion.div>

      {/* ---------- 7 + 8. UOM chips + recent activity ---------- */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SectionCard icon={<Boxes className="size-4" />} title="مقادیر وارداتی به تفکیک واحد">
          {data.stats.importedByUom.length === 0 ? (
            <div className="text-xs text-muted-foreground">
              در این بازه مقدار تأییدشده‌ای ثبت نشده است.
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {data.stats.importedByUom.map((u) => (
                <div
                  key={`${u.symbol}-${u.name}`}
                  className="flex items-center gap-2 rounded-lg border bg-secondary/50 px-2.5 py-1.5"
                  title={`${u.name} (${u.symbol})`}
                >
                  <span
                    aria-hidden
                    className="grid size-7 shrink-0 place-items-center rounded-md border border-primary/20 bg-card text-primary"
                  >
                    <Boxes className="size-3.5" />
                  </span>
                  <div>
                    <div className="text-[10px] text-muted-foreground">{u.name}</div>
                    <div className="text-xs font-bold tabular-nums">
                      {formatNumber(u.total)}{" "}
                      <span className="font-normal text-muted-foreground">{u.symbol}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-3 text-[11px] text-muted-foreground">
            مجموع مقدار تأییدشده ({analyticsHint}) — به تفکیک واحد. واحدهای متفاوت هرگز با هم جمع
            نمی‌شوند.
          </div>
        </SectionCard>

        <SectionCard icon={<History className="size-4" />} title="آخرین فعالیت‌ها">
          {activity.length === 0 ? (
            <EmptyState icon={<History className="size-5" />} title="فعالیتی ثبت نشده است." />
          ) : (
            <ActivityTimeline activity={activity} />
          )}
        </SectionCard>
      </div>
    </motion.div>
  );
}

// ============================================================
// DashboardView
// ============================================================

export default function DashboardView() {
  const user = useAppStore((s) => s.user);
  const role = user?.role ?? "";
  const isNationwide = role === "ADMIN";

  const [from, setFrom] = React.useState<string | null>(null);
  const [to, setTo] = React.useState<string | null>(null);
  const [days, setDays] = React.useState<7 | 30 | 90>(30);
  const [checkpointId, setCheckpointId] = React.useState<string | null>(null);
  const [groupId, setGroupId] = React.useState<string | null>(null);
  const [importerId, setImporterId] = React.useState<string | null>(null);
  const [itemId, setItemId] = React.useState<string | null>(null);

  const hasCustomRange = Boolean(from || to);
  const filtersActive = [checkpointId, groupId, importerId, itemId].some(Boolean);
  const resetAll = () => {
    setFrom(null);
    setTo(null);
    setCheckpointId(null);
    setGroupId(null);
    setImporterId(null);
    setItemId(null);
  };

  // Option lists for the ADMIN-only filters (server ignores them for
  // port-restricted users anyway, so non-admins never see or load them).
  const checkpointsQ = useQuery({
    queryKey: ["checkpoints", "dash-options"],
    queryFn: () =>
      apiFetch<{ checkpoints: { id: number; name: string; province: string }[] }>("/api/checkpoints"),
    staleTime: Infinity,
    enabled: isNationwide,
  });
  const importersQ = useQuery({
    queryKey: ["importers", "dash-options", groupId],
    queryFn: () =>
      apiFetch<{ importers: { id: number; name: string; companyName: string | null }[] }>(
        groupId ? `/api/importers?groupId=${groupId}` : "/api/importers"
      ),
    staleTime: Infinity,
    enabled: isNationwide,
  });
  const groupsQ = useQuery({
    queryKey: ["importer-groups", "dash-options"],
    queryFn: () =>
      apiFetch<{ groups: { id: number; code: string; name: string }[] }>(
        "/api/importer-groups?status=ACTIVE"
      ),
    staleTime: 60_000,
    enabled: isNationwide,
  });
  const itemsQ = useQuery({
    queryKey: ["items", "dash-options"],
    queryFn: () => apiFetch<{ items: { id: number; itemName: string; itemCode: string }[] }>("/api/items"),
    staleTime: Infinity,
    enabled: isNationwide,
  });

  const dash = useQuery({
    queryKey: ["dashboard", from, to, days, checkpointId, groupId, importerId, itemId],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("days", String(days));
      if (from) params.set("from", from);
      if (to) {
        // include the whole "to" day
        params.set("to", new Date(new Date(to).getTime() + 86399000).toISOString());
      }
      if (checkpointId) params.set("checkpointId", checkpointId);
      if (groupId) params.set("groupId", groupId);
      if (importerId) params.set("importerId", importerId);
      if (itemId) params.set("itemId", itemId);
      return apiFetch<DashboardData>(`/api/dashboard?${params.toString()}`);
    },
    refetchInterval: 60000,
  });

  return (
    <div className="space-y-4">
      {/* ---------- 1. Header ---------- */}
      <PageHeader
        title="داشبورد"
        breadcrumbs={breadcrumbItems("dashboard")}
        description={
          isNationwide
            ? "نمای کلی فعالیت‌های وارداتی در تمام بنادر — قابل فیلتر بر اساس بندر، گروپ، واردکننده و جنس"
            : `معلومات عملیاتی بندر مسئولیت شما${user?.checkpointName ? ` — ${user.checkpointName}` : ""}`
        }
        actions={
          <>
            <PortScopeChip
              isNationwide={isNationwide}
              checkpointName={user?.checkpointName}
            />
            <div className="flex flex-wrap items-center gap-2">
              <div className="w-36 sm:w-40">
                <JalaliDateInput
                  value={from}
                  onChange={setFrom}
                  placeholder="از تاریخ"
                  allowClear
                />
              </div>
              <div className="w-36 sm:w-40">
                <JalaliDateInput value={to} onChange={setTo} placeholder="تا تاریخ" allowClear />
              </div>
              {(hasCustomRange || filtersActive) && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-9 px-2.5 text-xs text-muted-foreground hover:text-foreground"
                  onClick={resetAll}
                  aria-label="بازنشانی همه فیلترها و بازه تاریخ"
                >
                  <RotateCcw className="size-3.5" aria-hidden />
                  بازنشانی
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="h-9"
                onClick={() => dash.refetch()}
                disabled={dash.isFetching}
                aria-label="به‌روزرسانی معلومات داشبورد"
              >
                <RefreshCw className={cn("size-4", dash.isFetching && "animate-spin")} aria-hidden />
                به‌روزرسانی
              </Button>
            </div>
          </>
        }
      />

      {/* ---------- Meta strip: applied range + last refresh ---------- */}
      {(hasCustomRange || dash.data) && (
        <div className="flex flex-wrap items-center gap-2 no-print">
          {hasCustomRange && (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-secondary px-2.5 py-1 text-xs font-medium text-primary">
              <CalendarRange className="size-3.5" aria-hidden />
              بازه: {formatJalali(from)} تا {formatJalali(to)}
              <button
                type="button"
                onClick={() => {
                  setFrom(null);
                  setTo(null);
                }}
                aria-label="حذف بازه تاریخ انتخابی"
                className="ms-0.5 rounded p-0.5 transition-colors hover:bg-primary/10"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </span>
          )}
          {dash.data && (
            <span
              className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1 text-[11px] text-muted-foreground"
              title={`آخرین بهروزرسانی: ${formatJalaliDateTime(dash.data.lastUpdated)}`}
            >
              <Clock className="size-3.5 text-gold" aria-hidden />
              آخرین بهروزرسانی:{" "}
              <span className="font-medium tabular-nums">{formatTime(dash.data.lastUpdated)}</span>
            </span>
          )}
        </div>
      )}

      {/* ---------- Admin-only filters ---------- */}
      {isNationwide && (
        <Card className="py-0 no-print">
          <CardContent className="space-y-3 p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Filter className="size-3.5 text-gold" aria-hidden />
              فیلتر معلومات
              {filtersActive && (
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary">
                  {toPersianDigits([checkpointId, groupId, importerId, itemId].filter(Boolean).length)} فیلتر فعال
                </span>
              )}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="flex flex-col gap-1">
                <span className="px-1 text-[11px] text-muted-foreground">بندر</span>
                <SearchSelect
                  value={checkpointId}
                  onChange={(v) => setCheckpointId(v)}
                  options={toOptions(
                    checkpointsQ.data?.checkpoints,
                    (c) => c.id,
                    (c) => c.name,
                    (c) => c.province
                  )}
                  placeholder="همه بنادر"
                  searchPlaceholder="جستجوی بندر…"
                  loading={checkpointsQ.isLoading}
                  allowClear
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="px-1 text-[11px] text-muted-foreground">گروپ</span>
                <SearchSelect
                  value={groupId}
                  onChange={(v) => {
                    setGroupId(v);
                    // The individual filter cannot contradict the group filter.
                    if (v && importerId) setImporterId(null);
                  }}
                  options={toOptions(groupsQ.data?.groups, (g) => g.id, (g) => g.name, (g) => g.code)}
                  placeholder="همه گروپ‌ها"
                  searchPlaceholder="جستجوی گروپ…"
                  loading={groupsQ.isLoading}
                  allowClear
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="px-1 text-[11px] text-muted-foreground">واردکننده (فردی)</span>
                <SearchSelect
                  value={importerId}
                  onChange={(v) => setImporterId(v)}
                  options={toOptions(
                    importersQ.data?.importers,
                    (i) => i.id,
                    (i) => i.name,
                    (i) => i.companyName
                  )}
                  placeholder={groupId ? "همه اعضای گروپ" : "همه واردکنندگان"}
                  searchPlaceholder="جستجوی واردکننده…"
                  loading={importersQ.isLoading}
                  allowClear
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="px-1 text-[11px] text-muted-foreground">جنس</span>
                <SearchSelect
                  value={itemId}
                  onChange={(v) => setItemId(v)}
                  options={toOptions(
                    itemsQ.data?.items,
                    (i) => i.id,
                    (i) => i.itemName,
                    (i) => i.itemCode
                  )}
                  placeholder="همه اجناس"
                  searchPlaceholder="جستجوی جنس…"
                  loading={itemsQ.isLoading}
                  allowClear
                />
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ---------- Content ---------- */}
      {dash.isLoading ? (
        <DashboardSkeleton />
      ) : !dash.data ? (
        <EmptyState
          icon={<RefreshCw className="size-5" />}
          title="بارگذاری داشبورد ناموفق بود"
          description="لطفاً دوباره تلاش کنید یا با مدیر سیستم تماس بگیرید."
          action={
            <Button variant="outline" size="sm" onClick={() => dash.refetch()}>
              تلاش مجدد
            </Button>
          }
        />
      ) : (
        <DashboardContent
          data={dash.data}
          role={role}
          days={days}
          onDaysChange={setDays}
          from={from}
          to={to}
        />
      )}
    </div>
  );
}

export { DashboardView };
