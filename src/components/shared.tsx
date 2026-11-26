"use client";

import * as React from "react";
import { toast } from "sonner";
import { Calendar as CalendarIcon, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ChevronsUpDown, Copy, Globe2, MapPin, Search, Wand2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn, compareValues } from "@/lib/utils";
import {
  ENTRY_STATUS_LABELS,
  EXCEPTION_STATUS_LABELS,
  STATUS_LABELS,
} from "@/lib/constants";
import {
  JALALI_MONTHS,
  WEEK_DAYS_FA,
  formatJalali,
  formatNumber,
  isValidJalali,
  jalaaliMonthLengthSafe,
  jalaliToUtc,
  kabulParts,
  parseJalaliString,
  toJalali,
  toPersianDigits,
} from "@/lib/jalali";

// ============================================================
// Status badges
// ============================================================

const ENTRY_STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-muted text-muted-foreground border-border",
  PENDING: "bg-warning-soft text-warning border-warning/30",
  APPROVED: "bg-success-soft text-success border-success/30",
  REJECTED: "bg-danger-soft text-danger border-danger/30",
  REVERSED: "bg-muted text-muted-foreground border-border",
};

export function EntryStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={cn("font-medium", ENTRY_STATUS_STYLES[status])}>
      {ENTRY_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

export function ActiveStatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        status === "ACTIVE"
          ? "bg-success-soft text-success border-success/30"
          : "bg-muted text-muted-foreground border-border"
      )}
    >
      {STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

export function ExceptionStatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="text-muted-foreground">—</span>;
  const styles: Record<string, string> = {
    PENDING: "bg-warning-soft text-warning border-warning/30",
    APPROVED: "bg-success-soft text-success border-success/30",
    REJECTED: "bg-danger-soft text-danger border-danger/30",
  };
  return (
    <Badge variant="outline" className={cn("font-medium", styles[status])}>
      {EXCEPTION_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

// ============================================================
// Page header + breadcrumbs
// ============================================================

export interface BreadcrumbItem {
  label: string;
  onClick?: () => void;
}

export function Breadcrumbs({ items }: { items: BreadcrumbItem[] }) {
  if (!items.length) return null;
  return (
    <nav aria-label="مسیر صفحه" className="mb-1.5 no-print">
      <ol className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        {items.map((item, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${item.label}-${i}`} className="flex items-center gap-1">
              {i > 0 && <span aria-hidden className="opacity-50">/</span>}
              {last ? (
                <span aria-current="page" className="font-medium text-foreground/80">
                  {item.label}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={item.onClick}
                  className="hover:text-foreground transition-colors"
                >
                  {item.label}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  breadcrumbs?: BreadcrumbItem[];
}) {
  return (
    <div className="mb-5">
      {breadcrumbs && <Breadcrumbs items={breadcrumbs} />}
      <div className="flex flex-col gap-3 sm:flex-row-reverse sm:items-center sm:justify-between">
        {/* Title block — LEFT side; Dari text keeps its natural RTL direction */}
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold text-primary">{title}</h1>
          {description && (
            <p className="text-sm text-muted-foreground mt-1">{description}</p>
          )}
        </div>
        {/* Primary actions — RIGHT side (Add/New button) */}
        {actions && (
          <div className="flex flex-wrap items-center gap-2 no-print shrink-0">
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Formatters
// ============================================================

/** Inline validation message — always rendered below its field. */
export function FieldError({ message }: { message: string }) {
  return (
    <p role="alert" className="text-xs leading-5 text-destructive flex items-start gap-1">
      <span aria-hidden className="mt-[3px]">٭</span>
      <span>{message}</span>
    </p>
  );
}

export function fmtQty(qty: number | null | undefined, uom?: string): string {
  if (qty === null || qty === undefined) return "—";
  return uom ? `${formatNumber(qty)} ${uom}` : formatNumber(qty);
}

// ============================================================
// Solar Hijri date input (Afghan calendar, Persian digits)
// ============================================================

export interface JalaliDateInputProps {
  value: string | null; // ISO string or null
  onChange: (iso: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  allowClear?: boolean;
}

export function JalaliDateInput({
  value,
  onChange,
  placeholder = "انتخاب تاریخ",
  disabled,
  className,
  allowClear = true,
}: JalaliDateInputProps) {
  const [open, setOpen] = React.useState(false);
  const selected = value ? toJalali(new Date(value)) : null;
  const [view, setView] = React.useState<{ jy: number; jm: number }>(() => {
    const today = toJalali(new Date());
    return { jy: selected?.jy ?? today.jy, jm: selected?.jm ?? today.jm };
  });

  React.useEffect(() => {
    if (selected) setView({ jy: selected.jy, jm: selected.jm });
  }, [value]);

  const [text, setText] = React.useState<string>("");

  const display = value ? formatJalali(new Date(value)) : "";

  const monthLen = jalaaliMonthLengthSafe(view.jy, view.jm);
  const firstDow = kabulParts(jalaliToUtc(view.jy, view.jm, 1)).dow; // 0=Sun..6=Sat
  const offset = (firstDow + 1) % 7; // Saturday-first column index
  const cells: (number | null)[] = [
    ...Array.from({ length: offset }, () => null),
    ...Array.from({ length: monthLen }, (_, i) => i + 1),
  ];

  const todayJ = toJalali(new Date());

  const pick = (jd: number) => {
    const iso = jalaliToUtc(view.jy, view.jm, jd).toISOString();
    onChange(iso);
    setOpen(false);
  };

  const commitText = () => {
    if (!text.trim()) return;
    const parsed = parseJalaliString(text);
    if (parsed) {
      onChange(jalaliToUtc(parsed.jy, parsed.jm, parsed.jd).toISOString());
    } else {
      toast.error("تاریخ وارد‌شده نامعتبر است. نمونه درست: ۱۴۰۴/۰۷/۱۵");
    }
    setText("");
  };

  const years = Array.from({ length: 21 }, (_, i) => todayJ.jy - 10 + i);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn(
            "justify-between font-normal h-9 w-full",
            !value && "text-muted-foreground",
            className
          )}
        >
          <span className="flex items-center gap-1.5 truncate">
            <CalendarIcon className="size-4 text-gold shrink-0" />
            {display || placeholder}
          </span>
          {value && allowClear && (
            <X
              className="size-4 opacity-50 hover:opacity-100 shrink-0"
              onClick={(e) => {
                e.stopPropagation();
                onChange(null);
              }}
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3" align="start">
        <div className="flex items-center gap-1 mb-2">
          <Select
            value={String(view.jm)}
            onValueChange={(v) => setView((s) => ({ ...s, jm: Number(v) }))}
          >
            <SelectTrigger className="h-8 flex-1 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {JALALI_MONTHS.map((m, i) => (
                <SelectItem key={m} value={String(i + 1)}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={String(view.jy)}
            onValueChange={(v) => setView((s) => ({ ...s, jy: Number(v) }))}
          >
            <SelectTrigger className="h-8 w-24 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-56">
              {years.map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {toPersianDigits(y)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-7 gap-0.5 mb-1">
          {WEEK_DAYS_FA.slice(6).concat(WEEK_DAYS_FA.slice(0, 6)).map((d) => (
            <div key={d} className="text-[10px] text-muted-foreground text-center py-0.5">
              {d.slice(0, 3)}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-0.5">
          {cells.map((jd, idx) => (
            <div key={idx} className="h-7">
              {jd !== null && (
                <button
                  type="button"
                  onClick={() => pick(jd)}
                  className={cn(
                    "w-full h-7 rounded text-xs hover:bg-accent transition-colors",
                    selected &&
                      selected.jy === view.jy &&
                      selected.jm === view.jm &&
                      selected.jd === jd
                      ? "bg-primary text-primary-foreground hover:bg-primary font-bold"
                      : todayJ.jy === view.jy && todayJ.jm === view.jm && todayJ.jd === jd
                        ? "border border-gold text-primary font-bold"
                        : ""
                  )}
                >
                  {toPersianDigits(jd)}
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between mt-2 pt-2 border-t">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => {
              onChange(jalaliToUtc(todayJ.jy, todayJ.jm, todayJ.jd).toISOString());
              setOpen(false);
            }}
          >
            امروز
          </Button>
          <div className="flex items-center gap-1">
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitText();
                }
              }}
              onBlur={commitText}
              placeholder="۱۴۰۴/۰۷/۱۵"
              className="h-7 w-28 text-xs text-center"
              dir="ltr"
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ============================================================
// Table helpers — sorting, pagination, toolbar
// ============================================================

export interface SortState {
  key: string;
  desc: boolean;
}

/** Sort rows by one of the provided column accessors (Dari-aware). */
export function useSortedRows<T>(
  rows: T[],
  accessors: Record<string, (row: T) => string | number | null>,
  initial?: SortState
) {
  const [sort, setSort] = React.useState<SortState | undefined>(initial);
  const sorted = React.useMemo(() => {
    if (!sort || !accessors[sort.key]) return rows;
    const acc = accessors[sort.key];
    const copy = [...rows];
    copy.sort((a, b) => {
      const cmp = compareValues(acc(a), acc(b));
      return sort.desc ? -cmp : cmp;
    });
    return copy;
  }, [rows, sort, accessors]);
  const toggleSort = (key: string) =>
    setSort((prev) => (prev?.key === key ? { key, desc: !prev.desc } : { key, desc: false }));
  return { sorted, sort, toggleSort };
}

/** Clickable sortable table header cell. */
export function SortHead({
  label,
  k,
  sort,
  onSort,
  className,
}: {
  label: string;
  k: string;
  sort?: SortState;
  onSort: (key: string) => void;
  className?: string;
}) {
  const active = sort?.key === k;
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(k)}
        className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
        aria-label={`مرتب‌سازی بر اساس ${label}`}
      >
        {label}
        {active ? (
          sort?.desc ? (
            <ChevronDown className="size-3" aria-hidden />
          ) : (
            <ChevronUp className="size-3" aria-hidden />
          )
        ) : (
          <ChevronsUpDown className="size-3 opacity-40" aria-hidden />
        )}
      </button>
    </TableHead>
  );
}

/** Client-side pagination for management tables. */
export function usePagedRows<T>(rows: T[], pageSize = 15) {
  const [page, setPage] = React.useState(1);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  React.useEffect(() => {
    if (page > pageCount) setPage(1);
  }, [pageCount, page]);
  const paged = React.useMemo(
    () => rows.slice((page - 1) * pageSize, page * pageSize),
    [rows, page, pageSize]
  );
  return { page, pageCount, paged, setPage, total: rows.length };
}

export function TablePagination({
  page,
  pageCount,
  total,
  onPage,
  entityLabel = "رکورد",
}: {
  page: number;
  pageCount: number;
  total: number;
  onPage: (p: number) => void;
  entityLabel?: string;
}) {
  if (total === 0) return null;
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 border-t bg-muted/30 text-xs text-muted-foreground">
      <div>
        مجموع {toPersianDigits(total)} {entityLabel}
      </div>
      {pageCount > 1 && (
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={page <= 1}
            onClick={() => onPage(page - 1)}
          >
            <ChevronRight className="size-3.5" />
            قبلی
          </Button>
          <span className="tabular-nums px-1">
            صفحه {toPersianDigits(page)} از {toPersianDigits(pageCount)}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={page >= pageCount}
            onClick={() => onPage(page + 1)}
          >
            بعدی
            <ChevronLeft className="size-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}

/** Toolbar with Dari search box + optional filter children. */
export function TableToolbar({
  value,
  onChange,
  placeholder = "جستجو…",
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col sm:flex-row gap-2 mb-3 no-print">
      <div className="relative flex-1 min-w-0">
        <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="ps-8 h-9"
          aria-label={placeholder}
        />
        {value && (
          <button
            type="button"
            onClick={() => onChange("")}
            aria-label="پاک کردن جستجو"
            className="absolute end-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

// ============================================================
// Confirm dialog
// ============================================================

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "تأیید",
  cancelLabel = "لغو",
  destructive = false,
  onConfirm,
  busy,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  busy?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm" dir="rtl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DialogFooter className="flex-row justify-start gap-2">
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "لطفاً صبر کنید..." : confirmLabel}
          </Button>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// Empty state
// ============================================================

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center gap-2">
      {icon && <div className="text-muted-foreground">{icon}</div>}
      <div className="font-medium">{title}</div>
      {description && <div className="text-sm text-muted-foreground max-w-md">{description}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

// ============================================================
// Quota inline summary for entry forms
// ============================================================

export function QuotaPill({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "ok" | "warn" | "danger";
}) {
  const tones: Record<string, string> = {
    default: "bg-muted text-foreground",
    ok: "bg-success-soft text-success",
    warn: "bg-warning-soft text-warning",
    danger: "bg-danger-soft text-danger",
  };
  return (
    <div className={cn("rounded-md px-2 py-1 text-xs flex flex-col items-center min-w-16", tones[tone])}>
      <span className="opacity-75">{label}</span>
      <span className="font-bold">{value}</span>
    </div>
  );
}

// ============================================================
// Table shell — standard list-page container (Task: list pages)
// Card container + toolbar slot + sticky header + footer slot.
// ============================================================

export function TableShell({
  toolbar,
  footer,
  children,
  maxHeight = "62vh",
  className,
  bodyClassName,
}: {
  toolbar?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  maxHeight?: string;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <div className={cn("rounded-xl border bg-card overflow-hidden", className)}>
      {toolbar && <div className="p-3 sm:p-4 no-print">{toolbar}</div>}
      <div
        className={cn("overflow-x-auto overflow-y-auto", bodyClassName)}
        style={{ maxHeight }}
      >
        {children}
      </div>
      {footer && <div className="no-print">{footer}</div>}
    </div>
  );
}

/** Consistent loading skeleton for data tables. */
export function TableSkeleton({
  rows = 6,
  cols = 5,
}: {
  rows?: number;
  cols?: number;
}) {
  return (
    <div className="p-4 space-y-3" aria-hidden role="presentation">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-3" style={{ opacity: 1 - r * 0.12 }}>
          {Array.from({ length: cols }).map((_, c) => (
            <div
              key={c}
              className="h-5 flex-1 rounded bg-muted animate-pulse"
              style={{ animationDelay: `${(r * cols + c) * 40}ms` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

// ============================================================
// Port scope chip — ONE consistent treatment of the user's effective
// port scope across every list page and form (replaces the three
// inconsistent non-admin filter patterns).
// ============================================================

export function PortScopeChip({
  isNationwide,
  checkpointName,
  className,
}: {
  isNationwide: boolean;
  checkpointName?: string | null;
  className?: string;
}) {
  if (isNationwide) {
    return (
      <div
        title="مدیر ملی — دسترسی به تمام بنادر کشور"
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border border-primary/20 bg-secondary px-2.5 py-1.5 text-xs font-medium text-primary whitespace-nowrap",
          className
        )}
      >
        <Globe2 className="size-3.5 shrink-0" aria-hidden />
        تمام بنادر
      </div>
    );
  }
  return (
    <div
      title={`بندر مسئولیت شما${checkpointName ? `: ${checkpointName}` : ""} — غیرقابل تغییر`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-gold/60 bg-gold/10 px-2.5 py-1.5 text-xs font-medium text-primary whitespace-nowrap",
        className
      )}
    >
      <MapPin className="size-3.5 shrink-0" aria-hidden />
      {checkpointName || "بندر تخصیص‌نشده"}
      <span className="opacity-60">—</span>
      <span className="opacity-80">بندر مسئولیت شما</span>
    </div>
  );
}

// ============================================================
// Form dialog — the ONE dialog design system (Task: dialogs)
// Sticky header/footer, scrollable body, responsive width, unsaved-
// change protection and standard busy/cancel states.
// ============================================================

type DialogSize = "sm" | "md" | "lg" | "xl";

const DIALOG_SIZES: Record<DialogSize, string> = {
  sm: "sm:max-w-md",
  md: "sm:max-w-2xl",
  lg: "sm:max-w-4xl",
  xl: "sm:max-w-6xl",
};

export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  icon,
  size = "md",
  busy,
  dirty,
  onSubmit,
  submitLabel = "ذخیره",
  cancelLabel = "لغو",
  submitDisabled,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: string;
  icon?: React.ReactNode;
  size?: DialogSize;
  busy?: boolean;
  /** Unsaved-change protection: asks for confirmation before closing. */
  dirty?: boolean;
  onSubmit?: (e: React.FormEvent) => void;
  submitLabel?: string;
  cancelLabel?: string;
  submitDisabled?: boolean;
  children: React.ReactNode;
  /** Extra footer content (left of the action buttons). */
  footer?: React.ReactNode;
}) {
  const [confirmClose, setConfirmClose] = React.useState(false);

  const requestClose = (v: boolean) => {
    if (!v && dirty && !busy) {
      setConfirmClose(true);
      return;
    }
    onOpenChange(v);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={requestClose}>
        <DialogContent
          className={cn(
            "p-0 gap-0 overflow-hidden flex flex-col max-h-[92vh] sm:max-h-[88vh] rounded-xl",
            DIALOG_SIZES[size]
          )}
          dir="rtl"
        >
          <DialogHeader className="px-4 sm:px-6 py-4 border-b bg-card shrink-0 text-start">
            <DialogTitle className="flex items-center gap-2 text-base sm:text-lg">
              {icon}
              {title}
            </DialogTitle>
            {description && (
              <DialogDescription className="text-xs sm:text-sm mt-1">
                {description}
              </DialogDescription>
            )}
          </DialogHeader>

          <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
            {onSubmit ? (
              <form
                id="form-dialog-body"
                onSubmit={(e) => {
                  e.preventDefault();
                  onSubmit(e);
                }}
                className="space-y-5"
              >
                {children}
              </form>
            ) : (
              <div className="space-y-5">{children}</div>
            )}
          </div>

          <DialogFooter className="px-4 sm:px-6 py-3 border-t bg-muted/40 shrink-0 flex-row items-center justify-between gap-2">
            <div className="min-w-0">{footer}</div>
            <div className="flex items-center gap-2 shrink-0">
              {onSubmit && (
                <Button
                  type="submit"
                  form="form-dialog-body"
                  disabled={busy || submitDisabled}
                >
                  {busy ? (
                    <span className="flex items-center gap-1.5">
                      <span className="size-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" aria-hidden />
                      لطفاً صبر کنید…
                    </span>
                  ) : (
                    submitLabel
                  )}
                </Button>
              )}
              <Button type="button" variant="outline" onClick={() => requestClose(false)}>
                {cancelLabel}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmClose}
        onOpenChange={setConfirmClose}
        title="بستن پنجره؟"
        description="تغییرات ذخیره‌نشده از بین می‌روند. آیا مطمئن هستید؟"
        confirmLabel="بستن بدون ذخیره"
        destructive
        onConfirm={() => {
          setConfirmClose(false);
          onOpenChange(false);
        }}
      />
    </>
  );
}

/** Section heading inside forms/dialogs (anchor for grouped fields). */
export function FormSection({
  title,
  description,
  children,
  columns = 2,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  /** 1 = single column (mobile-safe), 2 = two columns on desktop. */
  columns?: 1 | 2;
}) {
  return (
    <section className="space-y-3">
      <div className="border-b pb-2">
        <h3 className="text-sm font-bold text-foreground">{title}</h3>
        {description && (
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        )}
      </div>
      <div className={cn("grid gap-x-4 gap-y-3", columns === 2 ? "sm:grid-cols-2" : "grid-cols-1")}>
        {children}
      </div>
    </section>
  );
}

/** Label + value row for detail dialogs. */
export function InfoField({
  label,
  value,
  span,
}: {
  label: string;
  value?: React.ReactNode;
  /** Span 2 columns in the grid on desktop. */
  span?: boolean;
}) {
  return (
    <div className={cn("min-w-0", span && "sm:col-span-2")}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm font-medium mt-0.5 break-words">{value ?? "—"}</div>
    </div>
  );
}

// ============================================================
// AutoField — read-only presentation for SYSTEM-GENERATED values.
//
//   • pre-save:  shows the "پس از ذخیره به‌صورت خودکار تولید می‌شود" hint
//   • post-save: shows the value with a خودکار badge + copy button
// Never renders an input, never receives keyboard focus, and never
// produces a required-field error.
// ============================================================

export function AutoField({
  label,
  value,
  hint,
  className,
}: {
  label: string;
  /** Existing (already-issued) value, if any. */
  value?: string | null;
  hint?: string;
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable — non-fatal.
    }
  };
  return (
    <div className={cn("rounded-lg border border-dashed bg-muted/40 px-3 py-2.5", className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground font-medium">{label}</span>
        <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary">
          <Wand2 className="h-3 w-3" aria-hidden />
          خودکار
        </span>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        {value ? (
          <>
            <span className="font-mono text-sm font-bold" dir="ltr">
              {value}
            </span>
            <button
              type="button"
              onClick={copy}
              aria-label={`کاپی ${label}`}
              className="inline-flex shrink-0 items-center gap-1 rounded-md border bg-background px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {copied ? <Check className="h-3 w-3 text-success" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
              {copied ? "کاپی شد" : "کاپی"}
            </button>
          </>
        ) : (
          <span className="text-xs text-muted-foreground italic">
            {hint ?? "پس از ذخیره به‌صورت خودکار تولید می‌شود"}
          </span>
        )}
      </div>
    </div>
  );
}

// ============================================================
// KPI card — neutral dashboard metric (no multicolored cards)
// ============================================================

export function KpiCard({
  label,
  value,
  icon,
  hint,
  tone = "neutral",
  onClick,
}: {
  label: string;
  value: string | number;
  icon?: React.ReactNode;
  hint?: string;
  tone?: "neutral" | "warning" | "danger" | "success";
  onClick?: () => void;
}) {
  const tones: Record<string, string> = {
    neutral: "",
    warning: "text-warning",
    danger: "text-danger",
    success: "text-success",
  };
  const Wrapper = onClick ? "button" : "div";
  return (
    <Wrapper
      {...(onClick ? { type: "button", onClick } : {})}
      className={cn(
        "rounded-xl border bg-card p-4 text-start w-full transition-shadow",
        onClick && "hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground font-medium">{label}</span>
        {icon && <span className="text-muted-foreground">{icon}</span>}
      </div>
      <div className={cn("mt-2 text-2xl font-bold tabular-nums", tones[tone])}>
        {typeof value === "number" ? formatNumber(value) : value}
      </div>
      {hint && <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div>}
    </Wrapper>
  );
}
