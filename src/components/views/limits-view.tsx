"use client";

import * as React from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Activity,
  AlertTriangle,
  CalendarClock,
  CalendarX2,
  Eye,
  Gauge,
  Layers,
  Pencil,
  Plus,
  Power,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
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
  ActiveStatusBadge,
  ConfirmDialog,
  EmptyState,
  FieldError,
  FormDialog,
  FormSection,
  JalaliDateInput,
  KpiCard,
  PageHeader,
  PortScopeChip,
  QuotaPill,
  SortHead,
  TablePagination,
  TableShell,
  TableSkeleton,
  TableToolbar,
  usePagedRows,
  useSortedRows,
} from "@/components/shared";
import { apiFetch } from "@/lib/client-api";
import { useAppStore } from "@/store/app-store";
import { PERIOD_LABELS } from "@/lib/constants";
import { IMPORTER_TYPE_LABELS } from "@/lib/biometric/types";
import { breadcrumbItems } from "@/lib/nav";
import { formatJalali, formatNumber, jalaliToUtc, toJalali, toPersianDigits } from "@/lib/jalali";
import { searchMatch } from "@/lib/utils";
import { ImporterSummaryPanel } from "@/components/biometric/importer-summary-panel";

// ============================================================
// Create-quota form defaults: 50 (litres) per quota and a DAILY
// window — both remain fully editable before saving.
// ============================================================

const DEFAULT_ALLOWED_QTY = "50";
const DEFAULT_PERIOD_TYPE = "DAILY";
const DEFAULT_UOM_NAME = "لیتر";

// ============================================================
// Types
// ============================================================

interface LimitRow {
  id: number;
  ownerType: "INDIVIDUAL" | "GROUP";
  importerId: number | null;
  groupId: number | null;
  checkpointId: number;
  allowedQuantity: number;
  uomId: number;
  periodType: "DAILY" | "WEEKLY" | "MONTHLY" | "TOTAL";
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
  importer: { id: number; name: string; companyName: string | null; importerCode: string; groupId?: number | null } | null;
  group: {
    id: number;
    name: string;
    code: string;
    representative: { id: number; name: string; importerCode: string } | null;
    _count: { members: number };
  } | null;
  checkpoint: { name: string; province: string };
  restrictItem: { itemName: string; itemCode: string } | null;
  restrictCategory: { name: string } | null;
  uom: { id: number; name: string; symbol: string };
  creator: { name: string } | null;
}

interface MonitorRow {
  id: number;
  ownerType: "INDIVIDUAL" | "GROUP";
  importer: {
    id: number;
    name: string;
    companyName: string | null;
    importerCode: string;
    importerType: string;
    status: string;
    groupId?: number | null;
  } | null;
  group: {
    id: number;
    name: string;
    code: string;
    representative: { id: number; name: string; importerCode: string } | null;
    _count: { members: number };
  } | null;
  checkpoint: { id: number; name: string; province: string };
  restriction: { kind: "item" | "category"; label: string } | null;
  periodType: string;
  allowedQuantity: number;
  uom: { name: string; symbol: string };
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
  creator: string | null;
  validity: "valid" | "expired" | "scheduled";
  health: "ok" | "near" | "exhausted" | "exceeded" | "no_data";
  quota: {
    /** GROUP: the PER-MEMBER allowance. */
    allowedBaseQuantity: number;
    memberCount: number | null;
    /** GROUP: allowedBaseQuantity × memberCount. */
    totalAllowedQuantity: number | null;
    memberBreakdown: { importerId: number; name: string; importerCode: string; consumed: number; remaining: number; membershipStatus: string }[] | null;
    consumedBaseQuantity: number;
    availableBaseQuantity: number;
    excessBaseQuantity: number;
    usagePercent: number | null;
    windowLabel: string | null;
  } | null;
  nextBoundary: string | null;
}

interface MissingRow {
  key: string;
  ownerType: string;
  importer: { id: number; name: string; importerCode: string; importerType: string } | null;
  group: { id: number; name: string; code: string } | null;
  checkpointId: number;
}

type HealthFilter =
  | "all" | "near" | "exhausted" | "exceeded" | "expired" | "scheduled" | "active" | "ok" | "missing";

const HEALTH_BADGE: Record<MonitorRow["health"], { label: string; className: string }> = {
  ok: { label: "عادی", className: "bg-success-soft text-success border-success/30" },
  near: { label: "نزدیک به حد", className: "bg-warning-soft text-warning border-warning/30" },
  exhausted: { label: "تکمیل‌شده", className: "bg-warning-soft text-warning border-warning/30" },
  exceeded: { label: "بیش از حد", className: "bg-danger-soft text-danger border-danger/30" },
  no_data: { label: "بدون معلومات", className: "bg-muted text-muted-foreground border-border" },
};

const VALIDITY_BADGE: Record<MonitorRow["validity"], { label: string; className: string }> = {
  valid: { label: "فعال", className: "bg-success-soft text-success border-success/30" },
  expired: { label: "منقضی", className: "bg-danger-soft text-danger border-danger/30" },
  scheduled: { label: "آینده", className: "bg-warning-soft text-warning border-warning/30" },
};

const HEALTH_FILTERS: { key: HealthFilter; label: string }[] = [
  { key: "all", label: "همه" },
  { key: "active", label: "فعال" },
  { key: "near", label: "نزدیک به حد" },
  { key: "exhausted", label: "تکمیل‌شده" },
  { key: "exceeded", label: "بیش از حد" },
  { key: "expired", label: "منقضی" },
  { key: "scheduled", label: "آینده" },
  { key: "ok", label: "عادی" },
  { key: "missing", label: "بدون حد مجاز" },
];

/** Owner-type filter — INDIVIDUAL (one importer, one balance) vs GROUP
 *  (a PER-MEMBER allowance: each active member owns the full amount). */
type OwnerFilter = "all" | "INDIVIDUAL" | "GROUP";
const OWNER_FILTERS: { key: OwnerFilter; label: string }[] = [
  { key: "all", label: "همه انواع" },
  { key: "INDIVIDUAL", label: "فردی" },
  { key: "GROUP", label: "گروپی" },
];

// ============================================================
// LimitsView — Mode A: quota setup / Mode B: quota monitoring
// ============================================================

export default function LimitsView({
  reviewMode = false,
}: {
  reviewMode?: boolean;
}) {
  const user = useAppStore((s) => s.user);
  const isAdmin = user?.role === "ADMIN";
  const queryClient = useQueryClient();
  const createIntent = useAppStore((s) => s.createIntent);
  const consumeCreateIntent = useAppStore((s) => s.consumeCreateIntent);
  const consumePendingSearch = useAppStore((s) => s.consumePendingSearch);
  const consumeLimitIntent = useAppStore((s) => s.consumeLimitIntent);
  const setEntryIntent = useAppStore((s) => s.setEntryIntent);
  const setView = useAppStore((s) => s.setView);

  // ---------- toolbar filters ----------
  const [importerFilter, setImporterFilter] = React.useState<string | null>(null);
  const [groupFilter, setGroupFilter] = React.useState<string | null>(null);
  const [checkpointFilter, setCheckpointFilter] = React.useState<string | null>(null);
  const [statusFilter, setStatusFilter] = React.useState("all");
  const [search, setSearch] = React.useState("");
  const [healthFilter, setHealthFilter] = React.useState<HealthFilter>("all");
  const [ownerFilter, setOwnerFilter] = React.useState<OwnerFilter>("all");

  // ---------- dialogs ----------
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [toggleTarget, setToggleTarget] = React.useState<LimitRow | null>(null);
  const [qtyTarget, setQtyTarget] = React.useState<LimitRow | null>(null);
  const [qtyValue, setQtyValue] = React.useState("");
  const [qtyReason, setQtyReason] = React.useState("");
  const [qtyError, setQtyError] = React.useState<string | undefined>(undefined);
  const [qtyReasonError, setQtyReasonError] = React.useState<string | undefined>(undefined);
  const [summaryImporterId, setSummaryImporterId] = React.useState<number | null>(null);

  // ---------- options ----------
  const importersQ = useQuery({
    queryKey: ["importers", "limit-options"],
    queryFn: () =>
      apiFetch<{
        importers: {
          id: number;
          name: string;
          companyName: string | null;
          importerCode: string;
          importerType: string;
          status: string;
          groupId?: number | null;
        }[];
      }>("/api/importers"),
    staleTime: 60_000,
  });
  const checkpointsQ = useQuery({
    queryKey: ["checkpoints", "limit-options"],
    queryFn: () =>
      apiFetch<{ checkpoints: { id: number; name: string; province: string; status: string }[] }>(
        "/api/checkpoints"
      ),
    staleTime: 60_000,
  });
  const groupsQ = useQuery({
    queryKey: ["importer-groups", "ACTIVE"],
    queryFn: () =>
      apiFetch<{
        groups: Array<{
          id: number;
          code: string;
          name: string;
          status: string;
          representative: { id: number; name: string; importerCode: string } | null;
          _count: { members: number; subgroups: number };
        }>;
      }>("/api/importer-groups?status=ACTIVE"),
    // Also needed by the GROUP FILTER — available in both modes.
    staleTime: 60_000,
  });
  const itemsQ = useQuery({
    queryKey: ["items", "limit-options"],
    queryFn: () =>
      apiFetch<{
        items: { id: number; itemName: string; itemCode: string; status: string }[];
      }>("/api/items"),
    enabled: !reviewMode,
    staleTime: 60_000,
  });
  const uomsQ = useQuery({
    queryKey: ["uoms", "limit-options"],
    queryFn: () =>
      apiFetch<{ uoms: { id: number; code: string; name: string; symbol: string; status: string }[] }>(
        "/api/uoms"
      ),
    enabled: !reviewMode,
    staleTime: 60_000,
  });

  // ---------- main list (setup mode) ----------
  const limits = useQuery({
    placeholderData: keepPreviousData,
    queryKey: ["limits", importerFilter, checkpointFilter, statusFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (importerFilter) params.set("importerId", importerFilter);
      if (checkpointFilter) params.set("checkpointId", checkpointFilter);
      if (statusFilter === "active") params.set("status", "active");
      if (statusFilter === "inactive") params.set("status", "inactive");
      return apiFetch<{ limits: LimitRow[] }>(`/api/limits?${params.toString()}`);
    },
    enabled: !reviewMode,
  });

  // ---------- MONITORING (review mode) ----------
  const monitoring = useQuery({
    placeholderData: keepPreviousData,
    queryKey: ["limits-monitoring", healthFilter, importerFilter, checkpointFilter, statusFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("health", healthFilter);
      if (statusFilter === "active") params.set("status", "active");
      if (statusFilter === "inactive") params.set("status", "inactive");
      if (statusFilter === "all") params.set("status", "all");
      if (importerFilter) params.set("importerId", importerFilter);
      if (checkpointFilter) params.set("checkpointId", checkpointFilter);
      return apiFetch<{ rows: (MonitorRow | MissingRow)[]; missing?: boolean }>(
        `/api/limits/monitoring?${params.toString()}`
      );
    },
    enabled: reviewMode,
  });

  // Global-search hand-off (one-shot, on mount)
  React.useEffect(() => {
    const q = consumePendingSearch("limits");
    if (q) setSearch(q.q);
  }, [consumePendingSearch]);

  // ---------- table state ----------
  const monitorAll = React.useMemo(
    () =>
      (monitoring.data?.rows ?? [])
        .filter((r): r is MonitorRow => !monitoring.data?.missing)
        .filter((r) => ownerFilter === "all" || r.ownerType === ownerFilter),
    [monitoring.data, ownerFilter]
  );
  const missingAll = React.useMemo(
    () =>
      (monitoring.data?.rows ?? [])
        .filter((r): r is MissingRow => Boolean(monitoring.data?.missing))
        .filter((r) => ownerFilter === "all" || r.ownerType === ownerFilter),
    [monitoring.data, ownerFilter]
  );

  const rows = React.useMemo(() => {
    const all = limits.data?.limits ?? [];
    // Group filter: group-owned quotas of the selected گروپ AND individual
    // quotas whose owner belongs to that group.
    const byGroup = all.filter((r) =>
      groupFilter
        ? r.ownerType === "GROUP"
          ? String(r.group?.id ?? "") === groupFilter
          : String(r.importer?.groupId ?? "") === groupFilter
        : true
    );
    if (!search.trim()) return byGroup;
    return byGroup.filter((r) =>
      searchMatch(
        `${r.importer?.name ?? ""} ${r.importer?.companyName ?? ""} ${r.importer?.importerCode ?? ""} ${r.group?.name ?? ""} ${r.group?.code ?? ""} ${r.checkpoint.name}`,
        search
      )
    );
  }, [limits.data, search, groupFilter]);

  const monitorRows = React.useMemo(() => {
    const all = monitorAll.filter((r) =>
      groupFilter
        ? r.ownerType === "GROUP"
          ? String(r.group?.id ?? "") === groupFilter
          : String(r.importer?.groupId ?? "") === groupFilter
        : true
    );
    if (!search.trim()) return all;
    return all.filter((r) =>
      searchMatch(
        `${r.importer?.name ?? ""} ${r.importer?.importerCode ?? ""} ${r.group?.name ?? ""} ${r.group?.code ?? ""} ${r.checkpoint.name}`,
        search
      )
    );
  }, [monitorAll, search, groupFilter]);

  const missingRows = React.useMemo(() => {
    const all = missingAll.filter((r) =>
      groupFilter ? String(r.group?.id ?? "") === groupFilter : true
    );
    if (!search.trim()) return all;
    return all.filter((r) =>
      searchMatch(
        `${r.importer?.name ?? ""} ${r.importer?.importerCode ?? ""} ${r.group?.name ?? ""} ${r.group?.code ?? ""}`,
        search
      )
    );
  }, [missingAll, search, groupFilter]);

  const setupSorter = useSortedRows<LimitRow>(
    rows,
    React.useMemo(
      () => ({
        owner: (r) => r.importer?.name ?? r.group?.name ?? "",
        port: (r) => r.checkpoint.name,
        allowed: (r) => r.allowedQuantity,
        from: (r) => r.effectiveFrom,
        status: (r) => (r.isActive ? "1" : "0"),
      }),
      []
    )
  );
  const monitorSorter = useSortedRows<MonitorRow>(
    monitorRows,
    React.useMemo(
      () => ({
        owner: (r) => r.importer?.name ?? r.group?.name ?? "",
        port: (r) => r.checkpoint.name,
        usage: (r) => r.quota?.usagePercent ?? -1,
        available: (r) => r.quota?.availableBaseQuantity ?? -1,
      }),
      []
    )
  );
  const missingSorter = useSortedRows<MissingRow>(
    missingRows,
    React.useMemo(() => ({ owner: (r) => r.importer?.name ?? r.group?.name ?? "" }), [])
  );
  // Shared sort state for the active table (both modes use SortHead).
  const sort = reviewMode ? monitorSorter.sort : setupSorter.sort;
  const toggleSort = reviewMode ? monitorSorter.toggleSort : setupSorter.toggleSort;
  const sortedSetup = setupSorter.sorted;
  const sortedMonitor = monitorSorter.sorted;
  const sortedMissing = missingSorter.sorted;
  const activeSorted = reviewMode
    ? healthFilter === "missing"
      ? sortedMissing
      : sortedMonitor
    : sortedSetup;
  // The three tables share one paginator; rows are narrowed inside each
  // mode-guarded branch below.
  const paging = usePagedRows<LimitRow | MonitorRow | MissingRow>(activeSorted, 15);

  // ---------- monitoring KPIs ----------
  const healthCounts = React.useMemo(() => {
    const validRows = monitorAll.filter((r) => r.validity === "valid");
    return {
      valid: validRows.length,
      near: monitorAll.filter((r) => r.health === "near").length,
      exhausted: monitorAll.filter((r) => r.health === "exhausted").length,
      exceeded: monitorAll.filter((r) => r.health === "exceeded").length,
      groups: validRows.filter((r) => r.ownerType === "GROUP").length,
      individuals: validRows.filter((r) => r.ownerType === "INDIVIDUAL").length,
    };
  }, [monitorAll]);

  // ---------- create form state ----------
  const [ownerType, setOwnerType] = React.useState<"INDIVIDUAL" | "GROUP">("INDIVIDUAL");
  const [importerId, setImporterId] = React.useState<string | null>(null);
  const [groupId, setGroupId] = React.useState<string | null>(null);
  const [checkpointId, setCheckpointId] = React.useState<string | null>(null);
  const [allowedQuantity, setAllowedQuantity] = React.useState(DEFAULT_ALLOWED_QTY);
  const [uomId, setUomId] = React.useState<string | null>(null);
  const [periodType, setPeriodType] = React.useState(DEFAULT_PERIOD_TYPE);
  const [effectiveFrom, setEffectiveFrom] = React.useState<string | null>(null);
  const [effectiveTo, setEffectiveTo] = React.useState<string | null>(null);
  const [isActive, setIsActive] = React.useState(true);
  const [restrictItemId, setRestrictItemId] = React.useState<string | null>(null);
  const [restrictOpen, setRestrictOpen] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string | undefined>>({});

  const clearError = (key: string) =>
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));

  const selectedGroup = (groupsQ.data?.groups ?? []).find((g) => String(g.id) === groupId);
  const activeUoms = (uomsQ.data?.uoms ?? []).filter((u) => u.status === "ACTIVE");

  // AUTO-SELECT when exactly ONE eligible option exists (never arbitrary).
  React.useEffect(() => {
    if (!dialogOpen) return;
    const ports = (checkpointsQ.data?.checkpoints ?? []).filter((c) => c.status === "ACTIVE");
    if (!isAdmin && user?.checkpointId) {
      setCheckpointId(String(user.checkpointId));
    } else if (!checkpointId && ports.length === 1) {
      setCheckpointId(String(ports[0].id));
    }
     
  }, [dialogOpen, checkpointsQ.data, isAdmin, user?.checkpointId]);
  React.useEffect(() => {
    if (!dialogOpen) return;
    // Default balance unit: prefer لیتر explicitly, otherwise auto-select
    // when exactly one active unit exists (never arbitrary when several).
    if (!uomId) {
      const litre = activeUoms.find((u) => u.name === DEFAULT_UOM_NAME);
      if (litre) setUomId(String(litre.id));
      else if (activeUoms.length === 1) setUomId(String(activeUoms[0].id));
    }
     
  }, [dialogOpen, uomId, activeUoms]);
  React.useEffect(() => {
    if (!dialogOpen) return;
    const groups = groupsQ.data?.groups ?? [];
    if (ownerType === "GROUP" && !groupId && groups.length === 1) {
      setGroupId(String(groups[0].id));
    }
     
  }, [dialogOpen, ownerType, groupsQ.data, groupId]);
  React.useEffect(() => {
    if (!dialogOpen) return;
    if (ownerType === "INDIVIDUAL" && !importerId) {
      const actives = (importersQ.data?.importers ?? []).filter((i) => i.status === "ACTIVE");
      if (actives.length === 1) setImporterId(String(actives[0].id));
    }
     
  }, [dialogOpen, ownerType, importersQ.data, importerId]);

  // Snapshot of the prefilled defaults at dialog-open time; formDirty compares
  // against it so untouched presets never trigger the unsaved-changes guard.
  const [preset, setPreset] = React.useState<{
    importer: string | null;
    qty: string;
    period: string;
    from: string | null;
  }>({ importer: null, qty: DEFAULT_ALLOWED_QTY, period: DEFAULT_PERIOD_TYPE, from: null });

  const formDirty = Boolean(
    importerId !== preset.importer ||
      groupId ||
      allowedQuantity !== preset.qty ||
      periodType !== preset.period ||
      (effectiveFrom ?? null) !== preset.from ||
      effectiveTo
  );

  const resetForm = () => {
    setOwnerType("INDIVIDUAL");
    setImporterId(null);
    setGroupId(null);
    setCheckpointId(null);
    setAllowedQuantity(DEFAULT_ALLOWED_QTY);
    setUomId(null);
    setPeriodType(DEFAULT_PERIOD_TYPE);
    setEffectiveFrom(null);
    setEffectiveTo(null);
    setIsActive(true);
    setRestrictItemId(null);
    setRestrictOpen(false);
    setErrors({});
    setPreset({ importer: null, qty: DEFAULT_ALLOWED_QTY, period: DEFAULT_PERIOD_TYPE, from: null });
  };

  const openCreate = (presetImporter?: { importerId?: number }) => {
    resetForm();
    const now = new Date();
    const j = toJalali(now);
    const fromIso = jalaliToUtc(j.jy, j.jm, j.jd).toISOString();
    const importerStr = presetImporter?.importerId ? String(presetImporter.importerId) : null;
    setPreset({
      importer: importerStr,
      qty: DEFAULT_ALLOWED_QTY,
      period: DEFAULT_PERIOD_TYPE,
      from: fromIso,
    });
    setEffectiveFrom(fromIso);
    if (importerStr) {
      setOwnerType("INDIVIDUAL");
      setImporterId(importerStr);
    }
    setDialogOpen(true);
  };

  // Cross-view intent: "Define quota for this importer".
  React.useEffect(() => {
    if (!reviewMode && isAdmin) {
      const intent = consumeLimitIntent();
      if (intent?.importerId) openCreate({ importerId: intent.importerId });
    }
     
  }, []);

  const save = useMutation({
    mutationFn: () => {
      if (!effectiveFrom) throw new Error("لطفاً تاریخ شروع را انتخاب کنید.");
      return apiFetch("/api/limits", {
        method: "POST",
        body: JSON.stringify({
          ownerType,
          importerId: ownerType === "INDIVIDUAL" ? Number(importerId) : null,
          groupId: ownerType === "GROUP" ? Number(groupId) : null,
          checkpointId: Number(checkpointId),
          allowedQuantity: Number(allowedQuantity),
          uomId: Number(uomId),
          periodType,
          effectiveFrom,
          effectiveTo,
          isActive,
          restrictItemId: restrictItemId ? Number(restrictItemId) : null,
          restrictCategoryId: null,
        }),
      });
    },
    onSuccess: () => {
      toast.success("حد مجاز با موفقیت ثبت شد.");
      queryClient.invalidateQueries({ queryKey: ["limits"] });
      queryClient.invalidateQueries({ queryKey: ["limits-monitoring"] });
      setDialogOpen(false);
      resetForm();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const submit = () => {
    const next: Record<string, string | undefined> = {};
    if (ownerType === "INDIVIDUAL" && !importerId) next.importerId = "لطفاً واردکننده را انتخاب کنید.";
    if (ownerType === "GROUP" && !groupId) next.groupId = "لطفاً گروپ را انتخاب کنید.";
    if (!checkpointId) next.checkpointId = "لطفاً بندر را انتخاب کنید.";
    if (!allowedQuantity || Number(allowedQuantity) <= 0)
      next.allowedQuantity = "مقدار مجاز باید بیشتر از صفر باشد.";
    if (!uomId) next.uomId = "لطفاً واحد اندازه‌گیری را انتخاب کنید.";
    if (!periodType) next.periodType = "لطفاً مدت حد مجاز را انتخاب کنید.";
    if (!effectiveFrom) next.effectiveFrom = "لطفاً تاریخ شروع را انتخاب کنید.";
    if (effectiveTo && effectiveFrom && effectiveTo < effectiveFrom)
      next.effectiveTo = "تاریخ ختم نمی‌تواند قبل از تاریخ شروع باشد.";
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    save.mutate();
  };

  // ---------- admin: change allowed quantity (reason required) ----------
  const qtySave = useMutation({
    mutationFn: () => {
      const row = qtyTarget;
      if (!row) throw new Error("حد مجاز انتخاب نشده است.");
      return apiFetch(`/api/limits/${row.id}`, {
        method: "PUT",
        body: JSON.stringify({ allowedQuantity: Number(qtyValue), changeReason: qtyReason }),
      });
    },
    onSuccess: () => {
      toast.success("مقدار مجاز تغییر کرد؛ دلیل در سابقه سیستم ثبت شد.");
      queryClient.invalidateQueries({ queryKey: ["limits"] });
      queryClient.invalidateQueries({ queryKey: ["limits-monitoring"] });
      setQtyTarget(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const openQtyDialog = (row: LimitRow) => {
    setQtyValue(String(row.allowedQuantity));
    setQtyReason("");
    setQtyError(undefined);
    setQtyReasonError(undefined);
    setQtyTarget(row);
  };

  const submitQty = () => {
    const n = Number(qtyValue);
    if (!qtyValue.trim() || Number.isNaN(n) || n <= 0) {
      setQtyError("مقدار مجاز باید بیشتر از صفر باشد.");
      return;
    }
    if (qtyReason.trim().length < 3) {
      setQtyReasonError("برای تغییر مقدار حد مجاز، نوشتن دلیل ضروری است.");
      return;
    }
    setQtyError(undefined);
    setQtyReasonError(undefined);
    qtySave.mutate();
  };

  // ---------- admin: activate / deactivate ----------
  const toggleActive = useMutation({
    mutationFn: (row: LimitRow) =>
      apiFetch(`/api/limits/${row.id}`, {
        method: "PUT",
        body: JSON.stringify({ isActive: !row.isActive }),
      }),
    onSuccess: (_d, row) => {
      toast.success(row.isActive ? "حد مجاز غیرفعال شد." : "حد مجاز فعال شد.");
      queryClient.invalidateQueries({ queryKey: ["limits"] });
      queryClient.invalidateQueries({ queryKey: ["limits-monitoring"] });
      setToggleTarget(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Quick action «تعیین حد مجاز».
  React.useEffect(() => {
    if (createIntent === "limit" && isAdmin && !reviewMode) {
      if (consumeCreateIntent("limit")) openCreate();
    }
  }, [createIntent, isAdmin, reviewMode]);

  // ---------- conflict warning (same owner + port + UOM) ----------
  const conflictingRow = React.useMemo(() => {
    if (!checkpointId || !uomId) return null;
    const ownerId = ownerType === "INDIVIDUAL" ? importerId : groupId;
    if (!ownerId) return null;
    return (
      (limits.data?.limits ?? []).find(
        (r) =>
          r.isActive &&
          r.uomId === Number(uomId) &&
          r.checkpointId === Number(checkpointId) &&
          (ownerType === "INDIVIDUAL"
            ? r.ownerType === "INDIVIDUAL" && r.importerId === Number(ownerId)
            : r.ownerType === "GROUP" && r.groupId === Number(ownerId))
      ) ?? null
    );
  }, [ownerType, importerId, groupId, checkpointId, uomId, limits.data]);


  const hasFilter =
    Boolean(search) ||
    Boolean(importerFilter) ||
    Boolean(checkpointFilter) ||
    statusFilter !== "all" ||
    ownerFilter !== "all";

  return (
    <div>
      <PageHeader
        title={reviewMode ? "مانیتورینگ سهمیه‌ها" : "تعیین محدودیت واردات"}
        description={
          reviewMode
            ? "مصرف زنده هر حد مجاز — حد گروپی برای هر عضو جداگانه اعمال می‌شود"
            : "حد مجاز بر مجموع مقدار اجناس مجاز تطبیق می‌شود؛ حد گروپی سهم هر عضو است"
        }
        breadcrumbs={breadcrumbItems(reviewMode ? "limits-review" : "limits")}
        actions={
          isAdmin && !reviewMode ? (
            <Button onClick={() => openCreate()}>
              <Plus className="size-4" aria-hidden />
              حد مجاز جدید
            </Button>
          ) : undefined
        }
      />

      {/* Monitoring KPIs */}
      {reviewMode && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 mb-4">
          <KpiCard
            label="نزدیک به حد"
            value={monitoring.isLoading ? "…" : healthCounts.near}
            icon={<Activity className="size-4" aria-hidden />}
            hint="بالای آستانه هشدار"
            tone="warning"
            onClick={() => setHealthFilter("near")}
          />
          <KpiCard
            label="تکمیل‌شده / بیش از حد"
            value={monitoring.isLoading ? "…" : healthCounts.exhausted + healthCounts.exceeded}
            icon={<AlertTriangle className="size-4" aria-hidden />}
            hint="موجودی تمام یا عبور از حد"
            tone="danger"
            onClick={() => setHealthFilter("exceeded")}
          />
          <KpiCard
            label="حدود فعال معتبر"
            value={monitoring.isLoading ? "…" : healthCounts.valid}
            icon={<Gauge className="size-4" aria-hidden />}
            hint={`فردی: ${toPersianDigits(healthCounts.individuals)} · گروپی: ${toPersianDigits(healthCounts.groups)}`}
            tone="success"
            onClick={() => setHealthFilter("active")}
          />
          <KpiCard
            label="بدون حد مجاز"
            value={monitoring.isLoading ? "…" : healthFilter === "missing" ? sortedMissing.length : "—"}
            icon={<Layers className="size-4" aria-hidden />}
            hint="واردات فعال ۳۰ روز اخیر بدون حد"
            onClick={() => setHealthFilter("missing")}
          />
        </div>
      )}

      {/* Monitoring health + owner-type chips */}
      {reviewMode && (
        <div className="flex flex-wrap items-center gap-1.5 mb-3">
          {HEALTH_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setHealthFilter(f.key)}
              aria-pressed={healthFilter === f.key}
              className={
                "rounded-full border px-3 py-1 text-xs transition-colors " +
                (healthFilter === f.key
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card text-muted-foreground hover:bg-muted/60")
              }
            >
              {f.label}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
          <span className="text-[11px] text-muted-foreground">نوع مالک:</span>
          {OWNER_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setOwnerFilter(f.key)}
              aria-pressed={ownerFilter === f.key}
              className={
                "inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs transition-colors " +
                (ownerFilter === f.key
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card text-muted-foreground hover:bg-muted/60")
              }
            >
              {f.key === "GROUP" && <Users className="size-3" aria-hidden />}
              {f.label}
            </button>
          ))}
        </div>
      )}

      <TableShell
        toolbar={
          <>
            <TableToolbar value={search} onChange={setSearch} placeholder="جستجو…">
              <SearchSelect
                value={groupFilter}
                onChange={(v) => {
                  setGroupFilter(v);
                  // The individual filter cannot contradict the group filter.
                  if (v && importerFilter) setImporterFilter(null);
                }}
                options={toOptions(groupsQ.data?.groups, (g) => g.id, (g) => g.name, (g) => g.code)}
                placeholder="همه گروپ‌ها"
                searchPlaceholder="جستجوی گروپ…"
                loading={groupsQ.isLoading}
                allowClear
                className="sm:w-48"
              />
              <SearchSelect
                value={importerFilter}
                onChange={setImporterFilter}
                options={toOptions(
                  importersQ.data?.importers.filter(
                    (i) => !groupFilter || String(i.groupId ?? "") === groupFilter
                  ),
                  (i) => i.id,
                  (i) => i.name,
                  (i) => i.importerCode
                )}
                placeholder={groupFilter ? "همه اعضای گروپ" : "همه واردکنندگان"}
                searchPlaceholder="جستجوی واردکننده…"
                loading={importersQ.isLoading}
                allowClear
                className="sm:w-52"
              />
              {isAdmin ? (
                <SearchSelect
                  value={checkpointFilter}
                  onChange={setCheckpointFilter}
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
                  className="sm:w-48"
                />
              ) : (
                <PortScopeChip isNationwide={false} checkpointName={user?.checkpointName} className="sm:w-48" />
              )}
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="sm:w-40 h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">همه حالت‌ها</SelectItem>
                  <SelectItem value="active">فعال</SelectItem>
                  <SelectItem value="inactive">غیرفعال</SelectItem>
                </SelectContent>
              </Select>
            </TableToolbar>
            <div className="rounded-md border bg-muted/50 px-3 py-2 text-xs text-muted-foreground flex items-center gap-2 mb-3">
              <Gauge className="size-4 text-gold shrink-0" aria-hidden />
              {reviewMode
                ? "مصرف فقط ثبت‌های نهایی را شامل می‌شود؛ حد گروپی برای هر عضو جداگانه اعمال می‌شود — مجموع موجودی گروپ = حد هر عضو × تعداد اعضای فعال."
                : "هر حد بر مجموع مقدار اجناس مجاز تطبیق می‌شود؛ حد گروپی برای هر عضو جداگانه است. برای هر صاحب/بندر/واحد فقط یک حد فعال."}
            </div>
          </>
        }
        footer={
          <TablePagination
            page={paging.page}
            pageCount={paging.pageCount}
            total={paging.total}
            onPage={paging.setPage}
            entityLabel={healthFilter === "missing" ? "مورد" : "حد مجاز"}
          />
        }
      >
        {reviewMode ? (
          /* ================= MONITORING ================= */
          monitoring.isLoading ? (
            <TableSkeleton rows={6} cols={8} />
          ) : healthFilter === "missing" ? (
            sortedMissing.length === 0 ? (
              <EmptyState
                icon={<Gauge className="size-10" aria-hidden />}
                title="همه واردات فعال حد مجاز دارند"
                description="واردکنندگان/گروپ‌های فعال ۳۰ روز اخیر بدون حد مجاز اینجا فهرست می‌شوند."
              />
            ) : (
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-muted">
                  <TableRow>
                    <TableHead>نوع</TableHead>
                    <TableHead>صاحب</TableHead>
                    <TableHead>بندر</TableHead>
                    <TableHead className="no-print">عملیات</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paging.paged.map((r) => {
                    const m = r as MissingRow;
                    return (
                      <TableRow key={m.key} className="hover:bg-muted/40">
                        <TableCell>
                          {m.group ? (
                            <Badge variant="outline" className="bg-primary/10 text-primary border-primary/30">گروپی</Badge>
                          ) : (
                            <Badge variant="outline" className="bg-muted">فردی</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">
                          {m.group ? `گروپ: ${m.group.name}` : m.importer?.name}
                          <div className="text-xs text-muted-foreground tabular-nums">
                            {m.group?.code ?? m.importer?.importerCode}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="bg-muted/60">{m.checkpointId}</Badge>
                        </TableCell>
                        <TableCell className="no-print">
                          {isAdmin && m.importer ? (
                            <Button variant="outline" size="sm" onClick={() => openCreate({ importerId: m.importer!.id })}>
                              <Plus className="size-3.5" aria-hidden />
                              تعیین حد
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
            )
          ) : sortedMonitor.length === 0 ? (
            <EmptyState
              icon={<Activity className="size-10" aria-hidden />}
              title={hasFilter ? "موردی مطابق فیلتر یافت نشد" : "هیچ حد فعالی موجود نیست"}
              description={hasFilter ? "فیلترها را تغییر دهید." : "ابتدا حد مجاز تعریف کنید."}
            />
          ) : (
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-muted">
                <TableRow>
                  <TableHead>نوع</TableHead>
                  <TableHead>صاحب حد</TableHead>
                  <TableHead>بندر</TableHead>
                  <TableHead>محدودیت</TableHead>
                  <TableHead className="text-center">مقدار مجاز</TableHead>
                  <TableHead className="text-center">مصرف‌شده</TableHead>
                  <TableHead className="text-center">باقی‌مانده</TableHead>
                  <TableHead className="text-center hidden md:table-cell">اضافی</TableHead>
                  <SortHead label="درصد" k="usage" sort={sort} onSort={toggleSort} className="text-center" />
                  <TableHead>دوره جاری</TableHead>
                  <TableHead>وضعیت</TableHead>
                  <TableHead className="no-print">عملیات</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paging.paged.map((row) => {
                  const r = row as MonitorRow;
                  const health = HEALTH_BADGE[r.health];
                  const validity = VALIDITY_BADGE[r.validity];
                  const ownerName =
                    r.ownerType === "GROUP"
                      ? `گروپ: ${r.group?.name ?? "—"}`
                      : r.importer?.name ?? "—";
                  const ownerSub =
                    r.ownerType === "GROUP"
                      ? `${r.group?.code ?? ""} • ${formatNumber(r.group?._count.members ?? 0)} عضو`
                      : r.importer?.importerCode ?? "";
                  return (
                    <TableRow key={r.id} className="hover:bg-muted/40">
                      <TableCell>
                        {r.ownerType === "GROUP" ? (
                          <Badge variant="outline" className="bg-primary/10 text-primary border-primary/30">
                            <Users className="size-3" aria-hidden /> گروپی
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="bg-muted">فردی</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {r.ownerType === "INDIVIDUAL" && r.importer ? (
                          <button
                            type="button"
                            className="text-start hover:underline"
                            onClick={() => setSummaryImporterId(r.importer!.id)}
                          >
                            <div className="font-medium text-sm max-w-44 truncate">{ownerName}</div>
                            <div className="text-xs text-muted-foreground tabular-nums">{ownerSub}</div>
                          </button>
                        ) : (
                          <>
                            <div className="font-medium text-sm max-w-44 truncate">{ownerName}</div>
                            <div className="text-xs text-muted-foreground">{ownerSub}</div>
                          </>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="bg-muted/60">{r.checkpoint.name}</Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-32">
                        <div className="truncate">{r.restriction ? r.restriction.label : "همه اجناس مجاز"}</div>
                      </TableCell>
                      <TableCell className="text-center tabular-nums whitespace-nowrap">
                        <div>
                          {formatNumber(r.allowedQuantity)}{" "}
                          <span className="text-xs text-muted-foreground">{r.uom.symbol}</span>
                        </div>
                        {r.ownerType === "GROUP" && (
                          <div className="text-[10px] text-muted-foreground">
                            سهم هر عضو
                            {r.quota?.memberCount != null && r.quota.memberCount > 0 && (
                              <> · مجموع: {formatNumber(r.quota.totalAllowedQuantity ?? 0)} {r.uom.symbol}</>
                            )}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-center tabular-nums">
                        {r.quota ? formatNumber(r.quota.consumedBaseQuantity) : "—"}
                      </TableCell>
                      <TableCell className="text-center tabular-nums">
                        {r.quota ? formatNumber(r.quota.availableBaseQuantity) : "—"}
                      </TableCell>
                      <TableCell className="text-center tabular-nums hidden md:table-cell">
                        {r.quota && r.quota.excessBaseQuantity > 0 ? (
                          <span className="text-danger font-bold">+{formatNumber(r.quota.excessBaseQuantity)}</span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        {r.quota?.usagePercent == null ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          <Badge
                            variant="outline"
                            className={
                              r.health === "exceeded"
                                ? "bg-danger-soft text-danger border-danger/30"
                                : r.health === "exhausted" || r.health === "near"
                                  ? "bg-warning-soft text-warning border-warning/30"
                                  : "bg-success-soft text-success border-success/30"
                            }
                          >
                            {formatNumber(r.quota.usagePercent, 0)}٪
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-40">
                        <div className="truncate">{r.quota?.windowLabel ?? PERIOD_LABELS[r.periodType]}</div>
                      </TableCell>
                      <TableCell className="space-y-1">
                        <div>
                          <Badge variant="outline" className={validity.className}>{validity.label}</Badge>
                        </div>
                        <Badge variant="outline" className={health.className}>{health.label}</Badge>
                      </TableCell>
                      <TableCell className="no-print">
                        {isAdmin ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              openQtyDialog({
                                id: r.id,
                                ownerType: r.ownerType,
                                importerId: r.importer?.id ?? null,
                                groupId: r.group?.id ?? null,
                                checkpointId: r.checkpoint.id,
                                allowedQuantity: r.allowedQuantity,
                                uomId: 0,
                                periodType: r.periodType as LimitRow["periodType"],
                                effectiveFrom: r.effectiveFrom,
                                effectiveTo: r.effectiveTo,
                                isActive: r.isActive,
                                importer: r.importer
                                  ? {
                                      id: r.importer.id,
                                      name: r.importer.name,
                                      companyName: r.importer.companyName,
                                      importerCode: r.importer.importerCode,
                                    }
                                  : null,
                                group: r.group
                                  ? {
                                      id: r.group.id,
                                      name: r.group.name,
                                      code: r.group.code,
                                      representative: r.group.representative,
                                      _count: { members: r.group._count.members },
                                    }
                                  : null,
                                checkpoint: { name: r.checkpoint.name, province: r.checkpoint.province },
                                restrictItem: r.restriction?.kind === "item" ? { itemName: r.restriction.label, itemCode: "" } : null,
                                restrictCategory: r.restriction?.kind === "category" ? { name: r.restriction.label } : null,
                                uom: { id: 0, name: r.uom.name, symbol: r.uom.symbol },
                                creator: r.creator ? { name: r.creator } : null,
                              });
                            }}
                          >
                            <Pencil className="size-3.5" aria-hidden />
                            تعدیل
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
          )
        ) : /* ================= SETUP ================= */
        limits.isLoading ? (
          <TableSkeleton rows={6} cols={7} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Gauge className="size-10" aria-hidden />}
            title={hasFilter ? "موردی مطابق جستجو یافت نشد" : "هیچ حد مجازی تعریف نشده"}
            description={hasFilter ? "فیلترها را تغییر دهید." : "واردکننده یا گروپ بدون حد مجاز نمی‌تواند واردات ثبت کند."}
          />
        ) : (
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-muted">
              <TableRow>
                <TableHead>نوع</TableHead>
                <SortHead label="صاحب حد" k="owner" sort={sort} onSort={toggleSort} />
                <SortHead label="بندر" k="port" sort={sort} onSort={toggleSort} />
                <TableHead>محدودیت</TableHead>
                <SortHead label="مقدار مجاز" k="allowed" sort={sort} onSort={toggleSort} className="text-center" />
                <TableHead>مدت</TableHead>
                <SortHead label="از تاریخ" k="from" sort={sort} onSort={toggleSort} />
                <SortHead label="تا تاریخ" k="to" sort={sort} onSort={toggleSort} />
                <SortHead label="وضعیت" k="status" sort={sort} onSort={toggleSort} />
                {isAdmin && !reviewMode && <TableHead className="no-print">عملیات</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {paging.paged.map((row) => {
                // SETUP table renders quota rows only (mode-guarded above)
                const limit = row as LimitRow;
                return (
                  <TableRow key={limit.id} className="hover:bg-muted/40">
                    <TableCell>
                      {limit.ownerType === "GROUP" ? (
                        <Badge variant="outline" className="bg-primary/10 text-primary border-primary/30">
                          <Users className="size-3" aria-hidden /> گروپی
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="bg-muted">فردی</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="font-medium text-sm max-w-48 truncate">
                        {limit.ownerType === "GROUP" ? `گروپ: ${limit.group?.name ?? "—"}` : limit.importer?.name ?? "—"}
                      </div>
                      <div className="text-xs text-muted-foreground max-w-48 truncate tabular-nums">
                        {limit.ownerType === "GROUP"
                          ? `${limit.group?.code ?? ""} • ${formatNumber(limit.group?._count.members ?? 0)} عضو`
                          : `${limit.importer?.importerCode ?? ""}${limit.importer?.companyName ? ` • ${limit.importer.companyName}` : ""}`}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="bg-muted/60">{limit.checkpoint.name}</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-32">
                      <div className="truncate">
                        {limit.restrictItem
                          ? limit.restrictItem.itemName
                          : limit.restrictCategory
                            ? limit.restrictCategory.name
                            : "همه اجناس"}
                      </div>
                    </TableCell>
                    <TableCell className="text-center font-bold tabular-nums">
                      <div>
                        {formatNumber(limit.allowedQuantity)}{" "}
                        <span className="text-xs font-normal text-muted-foreground">{limit.uom.name}</span>
                      </div>
                      {limit.ownerType === "GROUP" && (
                        <div className="text-[10px] font-normal text-muted-foreground">سهم هر عضو گروپ</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="border-gold/60 text-primary bg-gold/10">
                        {PERIOD_LABELS[limit.periodType]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{formatJalali(limit.effectiveFrom)}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      {limit.effectiveTo ? formatJalali(limit.effectiveTo) : "—"}
                    </TableCell>
                    <TableCell>
                      <ActiveStatusBadge status={limit.isActive ? "ACTIVE" : "INACTIVE"} />
                    </TableCell>
                    {isAdmin && !reviewMode && (
                      <TableCell className="no-print">
                        <div className="flex items-center gap-1">
                          <Button variant="outline" size="sm" onClick={() => openQtyDialog(limit)}>
                            <Pencil className="size-3.5" aria-hidden />
                            تغییر مقدار
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => setToggleTarget(limit)}>
                            <Power className="size-3.5" aria-hidden />
                            {limit.isActive ? "غیرفعال‌سازی" : "فعال‌سازی"}
                          </Button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </TableShell>

      {/* ============ CREATE QUOTA DIALOG ============ */}
      <FormDialog
        open={dialogOpen}
        onOpenChange={(v) => {
          setDialogOpen(v);
          if (!v) resetForm();
        }}
        title="حد مجاز جدید"
        icon={<Gauge className="size-5 text-gold" aria-hidden />}
        size="lg"
        busy={save.isPending}
        dirty={formDirty}
        onSubmit={submit}
        submitLabel="ذخیره"
      >
        {/* Owner type */}
        <FormSection title="نوع حد مجاز" columns={1}>
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="نوع حد مجاز">
            {(
              [
                { key: "INDIVIDUAL", label: "فردی", desc: "یک واردکننده" },
                { key: "GROUP", label: "گروپی", desc: "برای هر عضو گروپ جداگانه" },
              ] as const
            ).map((t) => {
              const active = ownerType === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => {
                    setOwnerType(t.key);
                    setImporterId(null);
                    setGroupId(null);
                    clearError("importerId");
                    clearError("groupId");
                  }}
                  className={
                    "rounded-lg border p-2.5 text-start transition-colors " +
                    (active ? "border-primary bg-muted/50" : "border-border bg-card hover:bg-muted/40")
                  }
                >
                  <div className="text-sm font-medium">{t.label}</div>
                  <div className="text-xs text-muted-foreground">{t.desc}</div>
                </button>
              );
            })}
          </div>
        </FormSection>

        {/* Owner */}
        {ownerType === "INDIVIDUAL" ? (
          <FormSection title="واردکننده" columns={1}>
            <div className="space-y-1.5 min-w-0">
              <SearchSelect
                id="limit-importer"
                value={importerId}
                onChange={(v) => {
                  setImporterId(v);
                  clearError("importerId");
                }}
                options={toOptions(
                  importersQ.data?.importers.filter((i) => i.status === "ACTIVE"),
                  (i) => i.id,
                  (i) => i.name,
                  (i) => `${i.importerCode} • ${IMPORTER_TYPE_LABELS[i.importerType] ?? ""}`,
                  (i) => i.companyName
                )}
                placeholder="انتخاب واردکننده"
                searchPlaceholder="جستجو…"
                loading={importersQ.isLoading}
                invalid={!!errors.importerId}
                aria-label="واردکننده"
              />
              {errors.importerId && <FieldError message={errors.importerId} />}
            </div>
          </FormSection>
        ) : (
          <FormSection title="گروپ" columns={1}>
            <div className="space-y-1.5 min-w-0">
              <SearchSelect
                id="limit-group"
                value={groupId}
                onChange={(v) => {
                  setGroupId(v);
                  clearError("groupId");
                }}
                options={toOptions(groupsQ.data?.groups, (g) => g.id, (g) => g.name, (g) => g.code)}
                placeholder="انتخاب گروپ"
                searchPlaceholder="جستجو…"
                loading={groupsQ.isLoading}
                invalid={!!errors.groupId}
                aria-label="گروپ"
              />
              {errors.groupId && <FieldError message={errors.groupId} />}
            </div>
            {selectedGroup && (
              <div className="rounded-lg border bg-muted/40 p-2.5 text-xs space-y-1">
                <div className="flex flex-wrap gap-x-3">
                  <span>
                    نماینده:{" "}
                    {selectedGroup.representative
                      ? `${selectedGroup.representative.name} (${selectedGroup.representative.importerCode})`
                      : "— تعیین نشده —"}
                  </span>
                  <span>اعضای فعال: {formatNumber(selectedGroup._count.members)}</span>
                </div>
                <p className="text-primary font-medium">
                  حد مجاز برای هر عضو گروپ جداگانه اعمال می‌شود — هر عضو تا همین مقدار می‌تواند واردات کند.
                </p>
                {Number(allowedQuantity) > 0 && (
                  <p>
                    مجموع موجودی گروپ: {" "}
                    <span className="font-bold tabular-nums">
                      {formatNumber(Number(allowedQuantity) * selectedGroup._count.members)}
                    </span>{" "}
                    ({formatNumber(Number(allowedQuantity))} × {formatNumber(selectedGroup._count.members)} عضو فعال)
                  </p>
                )}
              </div>
            )}
          </FormSection>
        )}

        {/* Scope + amount */}
        <FormSection title="مقدار و دوره">
          <div className="space-y-1.5 min-w-0">
            <Label htmlFor="limit-checkpoint">بندر *</Label>
            <SearchSelect
              id="limit-checkpoint"
              value={checkpointId}
              onChange={(v) => {
                setCheckpointId(v);
                clearError("checkpointId");
              }}
              disabled={!isAdmin}
              disabledHint={
                isAdmin
                  ? undefined
                  : user?.checkpointName
                    ? `بندر مسئولیت شما: ${user.checkpointName}`
                    : undefined
              }
              options={toOptions(
                checkpointsQ.data?.checkpoints.filter((c) => c.status === "ACTIVE"),
                (c) => c.id,
                (c) => c.name,
                (c) => c.province
              )}
              placeholder="انتخاب بندر"
              searchPlaceholder="جستجو…"
              loading={checkpointsQ.isLoading}
              invalid={!!errors.checkpointId}
            />
            {errors.checkpointId && <FieldError message={errors.checkpointId} />}
          </div>
          <div className="space-y-1.5 min-w-0">
            <Label htmlFor="limit-uom">واحد موجودی *</Label>
            <SearchSelect
              id="limit-uom"
              value={uomId}
              onChange={(v) => {
                setUomId(v);
                clearError("uomId");
              }}
              options={toOptions(activeUoms, (u) => u.id, (u) => u.name, (u) => `(${u.symbol})`)}
              placeholder="مثلاً لیتر"
              searchPlaceholder="جستجو…"
              loading={uomsQ.isLoading}
              invalid={!!errors.uomId}
            />
            {errors.uomId && <FieldError message={errors.uomId} />}
          </div>
          <div className="space-y-1.5 min-w-0">
            <Label htmlFor="limit-qty">
              {ownerType === "GROUP" ? "مقدار مجاز برای هر عضو *" : "مقدار مجاز *"}
            </Label>
            <Input
              id="limit-qty"
              type="number"
              min="0"
              step="0.001"
              inputMode="decimal"
              dir="ltr"
              className="text-left"
              value={allowedQuantity}
              onChange={(e) => {
                setAllowedQuantity(e.target.value);
                clearError("allowedQuantity");
              }}
              placeholder="50"
              aria-invalid={!!errors.allowedQuantity}
            />
            {errors.allowedQuantity && <FieldError message={errors.allowedQuantity} />}
          </div>
          <div className="space-y-1.5 min-w-0">
            <Label htmlFor="limit-period">مدت *</Label>
            <Select
              value={periodType}
              onValueChange={(v) => {
                setPeriodType(v);
                clearError("periodType");
              }}
            >
              <SelectTrigger id="limit-period" aria-invalid={!!errors.periodType}>
                <SelectValue placeholder="انتخاب مدت" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="DAILY">روزانه</SelectItem>
                <SelectItem value="WEEKLY">هفتگی</SelectItem>
                <SelectItem value="MONTHLY">ماهانه</SelectItem>
                <SelectItem value="TOTAL">کلی (مجموعی)</SelectItem>
              </SelectContent>
            </Select>
            {errors.periodType && <FieldError message={errors.periodType} />}
          </div>
          <div className="space-y-1.5 min-w-0">
            <Label htmlFor="limit-from">تاریخ شروع *</Label>
            <JalaliDateInput
              value={effectiveFrom}
              onChange={(iso) => {
                setEffectiveFrom(iso);
                clearError("effectiveFrom");
              }}
            />
            {errors.effectiveFrom && <FieldError message={errors.effectiveFrom} />}
          </div>
          <div className="space-y-1.5 min-w-0">
            <Label htmlFor="limit-to">تاریخ ختم (اختیاری)</Label>
            <JalaliDateInput
              value={effectiveTo}
              onChange={(iso) => {
                setEffectiveTo(iso);
                clearError("effectiveTo");
              }}
            />
            {errors.effectiveTo && <FieldError message={errors.effectiveTo} />}
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2 sm:col-span-2">
            <div className="text-sm font-medium">حد مجاز فعال باشد</div>
            <Switch checked={isActive} onCheckedChange={setIsActive} aria-label="فعال بودن حد مجاز" />
          </div>
        </FormSection>

        {/* Optional eligibility restriction (collapsed) */}
        <div className="sm:col-span-2">
          <button
            type="button"
            className="text-xs text-muted-foreground underline hover:text-foreground"
            onClick={() => setRestrictOpen((v) => !v)}
          >
            {restrictOpen ? "− اجناس مجاز (اختیاری)" : "+ اجناس مجاز (اختیاری)"}
          </button>
          {restrictOpen && (
            <div className="mt-2 space-y-1.5 max-w-xs">
              <SearchSelect
                value={restrictItemId}
                onChange={setRestrictItemId}
                allowClear
                options={toOptions(
                  itemsQ.data?.items.filter((i) => i.status === "ACTIVE"),
                  (i) => i.id,
                  (i) => i.itemName,
                  (i) => i.itemCode
                )}
                placeholder="همه اجناس مجاز (بدون محدودیت)"
                searchPlaceholder="جستجوی جنس…"
                loading={itemsQ.isLoading}
                aria-label="محدودیت اجناس"
              />
              <p className="text-[10px] text-muted-foreground">
                در صورت انتخاب، فقط همان جنس از این حد مصرف می‌کند (محدودیت واجد شرایط بودن — نه موجودی جدا).
              </p>
            </div>
          )}
        </div>

        {/* Live helper + conflict */}
        {conflictingRow && (
          <div className="rounded-lg border border-warning/30 bg-warning-soft p-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-warning flex items-center gap-1.5">
              <AlertTriangle className="size-4 shrink-0" aria-hidden />
              برای همین صاحب، بندر و واحد یک حد فعال موجود است (مقدار: {formatNumber(conflictingRow.allowedQuantity)} {conflictingRow.uom.name}).
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => { setDialogOpen(false); openQtyDialog(conflictingRow); }}>
              <Pencil className="size-3.5" aria-hidden />
              باز کردن حد موجود
            </Button>
          </div>
        )}
        <div className="rounded-lg bg-muted p-3 text-xs text-muted-foreground space-y-1">
          <p className="font-medium text-foreground">این حد مجاز بر مجموع مقدار اجناس مجاز تطبیق می‌شود.</p>
          {ownerType === "GROUP" && (
            <p>
              حد گروپی برای هر عضو جداگانه محاسبه می‌شود — هر عضو تا مقدار تعیین‌شده واردات می‌کند (مجموع گروپ = مقدار حد × تعداد اعضای فعال).
            </p>
          )}
          {ownerType === "GROUP" && (
            <p>مثال گروپی: ۳ عضو × حد ۵۰ لیتری → هر عضو ۵۰ لیتر، مجموع گروپ ۱۵۰ لیتر.</p>
          )}
          {ownerType === "INDIVIDUAL" && (
            <p>مثال: حد ۵۰ لیتری → دیزل ۴۵ + پطرول ۵ = ۵۰ لیتر (یک موجودی، نه دو سهم جدا).</p>
          )}
        </div>
      </FormDialog>

      {/* Change-quantity dialog */}
      <FormDialog
        open={qtyTarget !== null}
        onOpenChange={(v) => {
          if (!v) setQtyTarget(null);
        }}
        title="تغییر مقدار مجاز"
        description={
          qtyTarget
            ? `${qtyTarget.ownerType === "GROUP" ? `گروپ: ${qtyTarget.group?.name}` : qtyTarget.importer?.name} — ${qtyTarget.checkpoint.name} • واحد: ${qtyTarget.uom.name}`
            : undefined
        }
        icon={<Pencil className="size-5 text-gold" aria-hidden />}
        size="sm"
        busy={qtySave.isPending}
        dirty={qtyValue !== String(qtyTarget?.allowedQuantity ?? "") || Boolean(qtyReason)}
        onSubmit={submitQty}
        submitLabel="ثبت مقدار جدید"
      >
        <FormSection title="مقدار جدید" columns={1}>
          <div className="space-y-1.5">
            <Label htmlFor="limit-qty-edit">
              {qtyTarget?.ownerType === "GROUP" ? "مقدار مجاز برای هر عضو *" : "مقدار مجاز *"}
            </Label>
            <Input
              id="limit-qty-edit"
              type="number"
              min="0"
              step="0.001"
              inputMode="decimal"
              dir="ltr"
              className="text-left"
              value={qtyValue}
              onChange={(e) => {
                setQtyValue(e.target.value);
                setQtyError(undefined);
              }}
              aria-invalid={!!qtyError}
            />
            {qtyError && <FieldError message={qtyError} />}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="limit-qty-reason">دلیل تغییر *</Label>
            <Input
              id="limit-qty-reason"
              value={qtyReason}
              onChange={(e) => {
                setQtyReason(e.target.value);
                setQtyReasonError(undefined);
              }}
              placeholder="دلیل تغییر مقدار"
              aria-invalid={!!qtyReasonError}
            />
            {qtyReasonError && <FieldError message={qtyReasonError} />}
          </div>
        </FormSection>
      </FormDialog>

      {/* Toggle confirm */}
      <ConfirmDialog
        open={toggleTarget !== null}
        onOpenChange={(v) => !v && setToggleTarget(null)}
        title={toggleTarget?.isActive ? "غیرفعال‌سازی حد مجاز" : "فعال‌سازی حد مجاز"}
        description={
          toggleTarget?.isActive
            ? `آیا حد مجاز «${toggleTarget?.ownerType === "GROUP" ? toggleTarget?.group?.name : toggleTarget?.importer?.name}» غیرفعال شود؟`
            : `آیا حد مجاز فعال شود؟ در صورت وجود حد فعال مشابه، فعال‌سازی رد می‌شود.`
        }
        confirmLabel={toggleTarget?.isActive ? "غیرفعال‌سازی" : "فعال‌سازی"}
        destructive={!!toggleTarget?.isActive}
        busy={toggleActive.isPending}
        onConfirm={() => toggleTarget && toggleActive.mutate(toggleTarget)}
      />

      {/* Importer profile hand-off */}
      <ImporterSummaryPanel
        importerId={summaryImporterId}
        open={summaryImporterId !== null}
        onOpenChange={(v) => !v && setSummaryImporterId(null)}
        onNewEntry={(importerId) => {
          setSummaryImporterId(null);
          setEntryIntent({ importerId });
          setView("entries");
        }}
      />
    </div>
  );
}

export { LimitsView };
