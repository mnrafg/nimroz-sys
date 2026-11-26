"use client";

import * as React from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  Clock,
  Eye,
  FilePlus2,
  FileUp,
  Loader2,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { SearchSelect, toOptions } from "@/components/ui/search-select";
import { PlAlert } from "@/components/ui/preline";
import {
  ConfirmDialog,
  EmptyState,
  EntryStatusBadge,
  FieldError,
  FormDialog,
  FormSection,
  InfoField,
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
import { TerminalImportListener } from "@/components/biometric/terminal-import-listener";
import { useAppStore } from "@/store/app-store";
import { portScopeFor } from "@/lib/scope";
import { newIdempotencyKey } from "@/lib/idempotency";
import { ACTION_LABELS, ENTRY_STATUS_LABELS, PERIOD_LABELS } from "@/lib/constants";
import { IMPORTER_TYPE_LABELS } from "@/lib/biometric/types";
import { breadcrumbItems } from "@/lib/nav";
import {
  formatJalali,
  formatJalaliDateTime,
  formatNumber,
  kabulParts,
  jalaliToUtc,
  toJalali,
  toPersianDigits,
} from "@/lib/jalali";

// ============================================================
// Types
// ============================================================

interface EntryItemRow {
  /** Client-side stable identity so quota reports survive row reindexing. */
  uid: string;
  id?: number;
  itemId: string;
  quantity: string;
  uomId: string;
}

interface EntryRow {
  id: number;
  entryNumber: string;
  importDatetime: string;
  vehicleNumber: string | null;
  status: string;
  remarks: string | null;
  importer: { id: number; name: string; companyName: string | null; importerCode: string };
  checkpoint: { id: number; name: string; province: string };
  creator: { id: number; name: string } | null;
  approver: { id: number; name: string } | null;
  rejecter: { id: number; name: string } | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  createdAt: string;
  updatedAt: string;
  items: EntryItemDetail[];
  actions?: EntryAction[];
}

interface EntryItemDetail {
  id: number;
  itemId: number;
  quantity: number;
  uomId: number;
  baseQuantity: number;
  exceptionStatus: string | null; // legacy rows only — no longer produced
  exceptionReason: string | null;
  remarks: string | null;
  item: { itemName: string; itemCode: string; baseUom: { id: number; name: string; symbol: string } };
  uom: { id: number; name: string; symbol: string };
  exceptionRequester: { name: string } | null;
  exceptionApprover: { name: string } | null;
  exceptionRejecter: { name: string } | null;
  // Per-row charge against the quota's shared balance (quota UOM).
  quotaUomQuantity: number | null;
  quotaConversionFactor: number | null;
  importLimit: { id: number; periodType: string; allowedQuantity: number; uom: { name: string; symbol: string } } | null;
}

interface EntryAction {
  id: number;
  actionType: string;
  actionAt: string;
  remarks: string | null;
  actor: { name: string };
}

interface QuotaResponse {
  quota: {
    hasLimit: boolean;
    conversionError?: boolean;
    limit?: {
      id: number;
      periodType: string;
      allowedQuantity: number;
      uomId: number;
      uomName: string;
      uomSymbol: string;
    };
    itemBaseUomId?: number;
    itemBaseUomName?: string;
    allowedBaseQuantity?: number;
    approvedBaseQuantity?: number;
    remainingBaseQuantity?: number;
    overQuota?: boolean;
    windowLabel?: string;
    requestedBaseQuantity?: number;
    excessBaseQuantity?: number;
    withinQuota?: boolean;
    projectedRemainingBaseQuantity?: number;
  };
}

/** Duplicate-transaction warning payload (server-computed). */
interface DuplicateCheckResponse {
  duplicates: {
    id: number;
    entryNumber: string;
    importDatetime: string;
    matchedItems: {
      itemId: number;
      itemName: string;
      quantity: number;
      uom: string;
      baseQuantity: number;
      similarMagnitude: boolean;
    }[];
  }[];
  windowMinutes: number;
}

/** Server-resolved quota for the WHOLE transaction (individual > group).
 *  GROUP quotas are PER-MEMBER: memberUsage carries the registering
 *  member's own allowance state, and projected remaining is member-level. */
interface ResolveResponse {
  resolution:
    | {
        status: "resolved";
        source: "INDIVIDUAL" | "GROUP";
        quota: {
          id: number;
          groupName: string | null;
          allowedQuantity: number;
          uomId: number;
          uomName: string;
          uomSymbol: string;
          periodType: string;
        };
        usage: {
          consumed: number;
          available: number;
          excess: number;
          usagePercent: number | null;
          windowLabel: string;
        };
        memberUsage: {
          importerId: number;
          allowedPerMember: number;
          consumedBefore: number;
          remainingBefore: number;
        } | null;
        totalCharge: number;
        projectedRemaining: number;
        projectedExcess: number;
        withinQuota: boolean;
      }
    | { status: "missing"; reason: string }
    | { status: "conflict"; reason: string }
    | { status: "incompatible"; reason: string };
}

let itemRowSeq = 0;
const emptyItemRow = (): EntryItemRow => {
  itemRowSeq += 1;
  return {
    uid: `row-${itemRowSeq}`,
    itemId: "",
    quantity: "",
    uomId: "",
  };
};

// ============================================================
// Main view
// ============================================================

export default function EntriesView() {
  const user = useAppStore((s) => s.user);
  const queryClient = useQueryClient();
  // Quick-action intent (from the top navbar) — opens the existing dialog.
  const createIntent = useAppStore((s) => s.createIntent);
  const consumeCreateIntent = useAppStore((s) => s.consumeCreateIntent);
  const consumePendingSearch = useAppStore((s) => s.consumePendingSearch);
  // Global-search hand-off source (reactive).
  const pendingSearch = useAppStore((s) => s.pendingSearch);

  // ---- list filters ----
  const [statusFilter, setStatusFilter] = React.useState("all");
  const [q, setQ] = React.useState("");
  const [debouncedQ, setDebouncedQ] = React.useState("");
  const [groupFilter, setGroupFilter] = React.useState<string | null>(null);
  const [importerFilter, setImporterFilter] = React.useState<string | null>(null);
  const [checkpointFilter, setCheckpointFilter] = React.useState<string | null>(null);

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const importersQ = useQuery({
    queryKey: ["importers", "entry-options", groupFilter],
    queryFn: () =>
      apiFetch<{
        importers: {
          id: number;
          name: string;
          companyName: string | null;
          importerCode: string;
          importerType: string;
          status: string;
        }[];
      }>(groupFilter ? `/api/importers?groupId=${groupFilter}` : "/api/importers"),
  });
  const groupsQ = useQuery({
    queryKey: ["importer-groups", "entry-options"],
    queryFn: () =>
      apiFetch<{ groups: { id: number; code: string; name: string }[] }>(
        "/api/importer-groups?status=ACTIVE"
      ),
    staleTime: 60_000,
  });
  const checkpointsQ = useQuery({
    queryKey: ["checkpoints", "entry-options"],
    queryFn: () => apiFetch<{ checkpoints: { id: number; name: string; province: string; status: string }[] }>("/api/checkpoints"),
  });
  const itemsQ = useQuery({
    queryKey: ["items", "entry-options"],
    queryFn: () =>
      apiFetch<{ items: { id: number; itemName: string; itemCode: string; baseUomId: number; baseUom: { id: number; name: string; symbol: string }; status: string }[] }>("/api/items"),
  });
  const uomsQ = useQuery({
    queryKey: ["uoms", "entry-options"],
    queryFn: () => apiFetch<{ uoms: { id: number; code: string; name: string; symbol: string; status: string }[] }>("/api/uoms"),
  });

  const entries = useQuery({
    placeholderData: keepPreviousData,
    queryKey: ["entries", statusFilter, debouncedQ, groupFilter, importerFilter, checkpointFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (debouncedQ.trim()) params.set("q", debouncedQ.trim());
      if (groupFilter) params.set("groupId", groupFilter);
      if (importerFilter) params.set("importerId", importerFilter);
      if (checkpointFilter) params.set("checkpointId", checkpointFilter);
      return apiFetch<{ entries: EntryRow[] }>(`/api/entries?${params.toString()}`);
    },
  });

  // Preset-aware header (approved/rejected pages reuse this view)
  const headerMeta = {
    title: "ثبت واردات",
    description: "ثبت واردات مرزی و مشاهده سهمیه باقی‌مانده — ثبت به‌صورت نهایی و بی‌نیاز از تأیید اضافی انجام می‌شود",
  };

  // ---- create/edit dialog state ----
  const [formOpen, setFormOpen] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);
  const [editingEntry, setEditingEntry] = React.useState<EntryRow | null>(null);
  const [importerId, setImporterId] = React.useState("");
  const [checkpointId, setCheckpointId] = React.useState("");
  const [dateIso, setDateIso] = React.useState<string | null>(null);
  const [timeText, setTimeText] = React.useState("");
  const [vehicleNumber, setVehicleNumber] = React.useState("");
  const [remarks, setRemarks] = React.useState("");
  const [itemRows, setItemRows] = React.useState<EntryItemRow[]>([emptyItemRow()]);
  const [errors, setErrors] = React.useState<Record<string, string | undefined>>({});
  const [reverseError, setReverseError] = React.useState<string | undefined>(undefined);
  // Live base-quantity reports keyed by row uid (for the TOTAL row).
  // Live quota resolution for the WHOLE transaction (compact summary).

  // ---- automation state ----
  const consumeEntryIntent = useAppStore((s) => s.consumeEntryIntent);
  /** Idempotency key for THIS dialog session — retries of the same create
   *  request replay the same record instead of creating duplicates. */
  const idemKeyRef = React.useRef<string>(newIdempotencyKey());
  /** Private recoverable draft id while autosave is active (create mode). */
  const autosaveIdRef = React.useRef<number | null>(null);
  const autosaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [autosaveStatus, setAutosaveStatus] = React.useState<"idle" | "saving" | "saved" | "failed">("idle");
  /** Current form snapshot + last successfully autosaved snapshot (refs —
   *  read inside timers without re-rendering). */
  const formSnapshotRef = React.useRef("");
  const lastAutosaveJsonRef = React.useRef("");
  /** Manual save in progress — autosave stays fully disabled until the
   *  dialog resets, so the finalize can never race the autosave. */
  const manualSaveRef = React.useRef(false);
  /** Set after an autosave failure; only cleared when content changes. */
  const autosaveFailedRef = React.useRef(false);
  /** Post-finalize success dialog (saved number + balances + next actions). */
  const [savedEntry, setSavedEntry] = React.useState<EntryRow | null>(null);
  const [sameImporterNext, setSameImporterNext] = React.useState(true);
  const [dupDismissed, setDupDismissed] = React.useState(false);

  const clearError = (key: string) =>
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));

  // ---- detail / misc dialogs ----
  const [detailId, setDetailId] = React.useState<number | null>(null);

  // Global-search hand-off — reactive so it also fires when THIS view is
  // already open: seed the search text AND open the clicked entry's
  // detail dialog (focusId).
  React.useEffect(() => {
    if (!pendingSearch || pendingSearch.view !== "entries") return;
    const seeded = consumePendingSearch("entries");
    if (!seeded) return;
    setQ(seeded.q);
    if (typeof seeded.focusId === "number") setDetailId(seeded.focusId);
  }, [pendingSearch, consumePendingSearch]);

  const detail = useQuery({
    queryKey: ["entry-detail", detailId],
    queryFn: () => apiFetch<{ entry: EntryRow }>(`/api/entries/${detailId}`),
    enabled: detailId !== null,
  });
  const [deleteTarget, setDeleteTarget] = React.useState<EntryRow | null>(null);
  const [reverseTarget, setReverseTarget] = React.useState<EntryRow | null>(null);
  const [reverseReason, setReverseReason] = React.useState("");
  const [submitTarget, setSubmitTarget] = React.useState<EntryRow | null>(null);

  const canCreate = user?.role === "ADMIN" || user?.role === "OFFICER";
  const canReverse = user?.role === "ADMIN";
  // Port-level scope for this user (mirrors the server-side enforcement).
  const scope = portScopeFor({ role: user?.role ?? "", checkpointId: user?.checkpointId ?? null });
  const isPortLocked = scope.kind === "port";
  const isNationwide = scope.kind === "all";

  const activeImporters = (importersQ.data?.importers ?? []).filter((i) => i.status === "ACTIVE");
  const activeCheckpoints = (checkpointsQ.data?.checkpoints ?? []).filter((c) => c.status === "ACTIVE");
  const activeItems = (itemsQ.data?.items ?? []).filter((i) => i.status === "ACTIVE");
  const activeUoms = (uomsQ.data?.uoms ?? []).filter((u) => u.status === "ACTIVE");

  const resetForm = () => {
    setEditingEntry(null);
    setImporterId("");
    setCheckpointId("");
    setDateIso(null);
    setTimeText("");
    setVehicleNumber("");
    setRemarks("");
    setItemRows([emptyItemRow()]);
    setErrors({});
    setDirty(false);
    // Fresh transaction context: new idempotency key, no autosave draft,
    // no stale duplicate warnings, fresh Kabul date/time.
    idemKeyRef.current = newIdempotencyKey();
    autosaveIdRef.current = null;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    manualSaveRef.current = false;
    autosaveFailedRef.current = false;
    lastAutosaveJsonRef.current = "";
    setAutosaveStatus("idle");
    setDupDismissed(false);
  };

  const openCreate = (presetImporterId?: number) => {

    resetForm();
    const p = kabulParts(new Date());
    setDateIso(jalaliToUtc(toJalali(new Date()).jy, toJalali(new Date()).jm, toJalali(new Date()).jd).toISOString());
    setTimeText(`${String(p.h).padStart(2, "0")}:${String(p.min).padStart(2, "0")}`);
    // Non-admin officers always register against their OWN assigned port.
    // Admin (nationwide): default to the port when exactly one is active
    // (e.g. نیمروز) — never an arbitrary pick with several ports.
    if (user?.checkpointId) setCheckpointId(String(user.checkpointId));
    else if (activeCheckpoints.length === 1) setCheckpointId(String(activeCheckpoints[0].id));
    // Context hand-off ("New import" from a profile / fingerprint match):
    // the importer arrives pre-selected, never re-typed.
    if (presetImporterId) setImporterId(String(presetImporterId));
    setFormOpen(true);
  };

  // Cross-view intent: "New import for this importer" (e.g. from the
  // importer profile in «واردکنندگان») consumed on mount.
  React.useEffect(() => {
    const intent = consumeEntryIntent();
    if (intent?.importerId && canCreate) openCreate(intent.importerId);
     
  }, []);

  // Quick action "ثبت واردات": open the existing creation dialog once.
  React.useEffect(() => {
    if (createIntent === "entry" && canCreate) {
      if (consumeCreateIntent("entry")) openCreate();
    }
  }, [createIntent, canCreate]);

  // Single-UOM default — when exactly one unit exists (e.g. لیتر), preselect
  // it in every item row instead of forcing a manual pick per row.
  React.useEffect(() => {
    if (activeUoms.length !== 1) return;
    const only = String(activeUoms[0].id);
    setItemRows((rows) =>
      rows.some((r) => !r.uomId) ? rows.map((r) => (r.uomId ? r : { ...r, uomId: only })) : rows
    );
  }, [activeUoms, itemRows]);

  // Single-checkpoint default — for nationwide admins without a fixed port,
  // when exactly one ACTIVE checkpoint exists (e.g. نیمروز), keep the بندر
  // preselected even if the checkpoint list arrives after the dialog opened.
  // Editing keeps the entry's own port; manual picks are never overridden.
  React.useEffect(() => {
    if (user?.checkpointId) return;
    if (!formOpen || editingEntry) return;
    if (activeCheckpoints.length !== 1) return;
    setCheckpointId((cur) => cur || String(activeCheckpoints[0].id));
  }, [activeCheckpoints, formOpen, editingEntry, user?.checkpointId]);

  const openEdit = (entry: EntryRow) => {
    setErrors({});
    setDirty(false);
    // Editing an existing draft: no autosave (it is saved explicitly).
    autosaveIdRef.current = null;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    setAutosaveStatus("idle");
    setDupDismissed(false);
    setEditingEntry(entry);
    setImporterId(String(entry.importer.id));
    setCheckpointId(String(entry.checkpoint.id));
    const j = toJalali(new Date(entry.importDatetime));
    setDateIso(jalaliToUtc(j.jy, j.jm, j.jd).toISOString());
    const p = kabulParts(new Date(entry.importDatetime));
    setTimeText(`${String(p.h).padStart(2, "0")}:${String(p.min).padStart(2, "0")}`);
    setVehicleNumber(entry.vehicleNumber ?? "");
    setRemarks(entry.remarks ?? "");
    setItemRows(
      entry.items.map((it) => ({
        uid: `edit-${it.id}`,
        id: it.id,
        itemId: String(it.itemId),
        quantity: String(it.quantity),
        uomId: String(it.uomId),
      }))
    );
    setFormOpen(true);
  };

  const addItemRow = () => {
    setItemRows((rows) => [...rows, emptyItemRow()]);
    setDirty(true);
  };
  const removeItemRow = (idx: number) => {
    setItemRows((rows) => (rows.length > 1 ? rows.filter((_, i) => i !== idx) : rows));
    // Item errors are keyed by row index — clear them so they cannot go stale
    setErrors((prev) => {
      const next: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (!k.startsWith("items")) next[k] = v;
      }
      return next;
    });
    setDirty(true);
  };

  const updateRow = (idx: number, patch: Partial<EntryItemRow>) => {
    setItemRows((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
    setDirty(true);
    // Clear inline errors for the fields the user just changed (the duplicate
    // message is keyed by itemId but triggered by the itemId+uomId pair).
    setErrors((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(patch)) delete next[`items.${idx}.${key}`];
      if ("itemId" in patch || "uomId" in patch) delete next[`items.${idx}.itemId`];
      delete next.items;
      return next;
    });
  };

  // Duplicate line items (same itemId + uomId twice) — shown live, blocks submit.
  const duplicateRowUids = React.useMemo(() => {
    const seen = new Map<string, string>();
    const dupes = new Set<string>();
    for (const r of itemRows) {
      if (!r.itemId || !r.uomId) continue;
      const key = `${r.itemId}|${r.uomId}`;
      if (seen.has(key)) dupes.add(r.uid);
      else seen.set(key, r.uid);
    }
    return dupes;
  }, [itemRows]);

  // Build final ISO datetime from Jalali date + time text
  const buildDatetime = (): string | null => {
    if (!dateIso) return null;
    const m = /^(\d{1,2}):(\d{2})$/.exec(timeText.trim());
    const base = new Date(dateIso).getTime();
    if (!m) return new Date(base).toISOString();
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return new Date(base + (h * 60 + min) * 60000).toISOString();
  };

  const saveEntry = useMutation({
    mutationFn: (action: "draft" | "submit") => {
      const importDatetime = buildDatetime();
      if (!importDatetime) throw new Error("لطفاً تاریخ و ساعت واردات را درست تعیین کنید.");
      const payload = {
        importerId: Number(importerId),
        checkpointId: Number(checkpointId),
        importDatetime,
        vehicleNumber: vehicleNumber.trim() || null,
        remarks: remarks.trim() || null,
        action,
        // Retrying the same create request replays the SAME record instead
        // of creating another one (double-clicks, flaky networks).
        idempotencyKey: editingEntry ? null : idemKeyRef.current,
        items: itemRows.map((r) => ({
          itemId: Number(r.itemId),
          quantity: Number(r.quantity),
          uomId: Number(r.uomId),
        })),
      };
      // An autosaved private draft is CONTINUED (same record, same number)
      // instead of creating a second registration.
      if (editingEntry) {
        return apiFetch<{ entry: EntryRow }>(`/api/entries/${editingEntry.id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
      }
      if (autosaveIdRef.current) {
        return apiFetch<{ entry: EntryRow }>(`/api/entries/${autosaveIdRef.current}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
      }
      return apiFetch<{ entry: EntryRow; idempotentReplay?: boolean }>("/api/entries", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },
    onSuccess: (data, action) => {
      const entry = (data as { entry: EntryRow }).entry;
      // Mark current content as saved so autosave stays quiet.
      lastAutosaveJsonRef.current = formSnapshotRef.current;
      queryClient.invalidateQueries({ queryKey: ["entries"] });
      queryClient.invalidateQueries({ queryKey: ["entry-detail"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
      queryClient.invalidateQueries({ queryKey: ["importer-summary-strip"] });
      if (autosaveIdRef.current && !editingEntry && action === "submit") {
        autosaveIdRef.current = null;
      }
      if (action === "submit") {
        // Success panel renders INSIDE the same dialog (no stacked dialogs):
        // saved number + fresh balances + next actions.
        // Content is committed — mark it saved and STOP the autosave:
        // the finalized entry can never be a draft target again.
        setDirty(false);
        lastAutosaveJsonRef.current = formSnapshotRef.current;
        setSavedEntry(entry);
        toast.success("ثبت واردات نهایی شد و سهمیه به‌روز شد.");
      } else {
        toast.success("ثبت واردات به صورت مسوده ذخیره شد.");
        setFormOpen(false);
        setSavedEntry(null);
      }
    },
    onError: (e: Error) => {
      toast.error(e.message);
      // Failed saves keep every entered value — the dialog stays open.
    },
  });

  // ---- AUTOSAVE (create mode only): private recoverable draft after
  // meaningful edits. Never finalizes, never saves an empty form, and
  // reuses the same draft id during retries. Paused once the transaction
  // is finalized (success panel) or a manual save is in flight. ----
  const autosaveMeaningful =
    formOpen && !editingEntry && !savedEntry && dirty &&
    !!importerId && !!checkpointId &&
    itemRows.some((r) => r.itemId && r.uomId && Number(r.quantity) > 0);

  const autosaveSave = useMutation({
    mutationFn: async () => {
      const importDatetime = buildDatetime();
      if (!importDatetime) throw new Error("invalid-datetime");
      const payload = {
        importerId: Number(importerId),
        checkpointId: Number(checkpointId),
        importDatetime,
        vehicleNumber: vehicleNumber.trim() || null,
        remarks: remarks.trim() || null,
        action: "draft" as const,
        // Dedicated key so an autosave retry can never mint a second draft.
        idempotencyKey: `autosave-${idemKeyRef.current}`,
        items: itemRows
          .filter((r) => r.itemId && r.uomId && Number(r.quantity) > 0)
          .map((r) => ({
            itemId: Number(r.itemId),
            quantity: Number(r.quantity),
            uomId: Number(r.uomId),
          })),
      };
      if (autosaveIdRef.current) {
        return apiFetch<{ entry: EntryRow }>(`/api/entries/${autosaveIdRef.current}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
      }
      return apiFetch<{ entry: EntryRow }>("/api/entries", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },
    onSuccess: (data) => {
      // Re-bind ONLY a genuine draft: an idempotent replay of an already
      // finalized autosave must never become the autosave target again.
      if (!autosaveIdRef.current && data.entry.status === "DRAFT") {
        autosaveIdRef.current = data.entry.id;
      }
      setAutosaveStatus("saved");
      queryClient.invalidateQueries({ queryKey: ["entries"] });
    },
    onError: (e: Error) => {
      autosaveFailedRef.current = true;
      // The draft was finalized elsewhere (e.g. our own finalize won the
      // race): nothing to recover — treat as saved and stop.
      if (e.message.includes("مسوده")) {
        lastAutosaveJsonRef.current = formSnapshotRef.current;
        setAutosaveStatus("idle");
      } else {
        setAutosaveStatus("failed");
      }
    },
  });

  React.useEffect(() => {
    if (!autosaveMeaningful || manualSaveRef.current || saveEntry.isPending || autosaveSave.isPending) return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      setAutosaveStatus("saving");
      autosaveSave.mutate();
    }, 2500);
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
     
  }, [autosaveMeaningful, importerId, checkpointId, dateIso, timeText, vehicleNumber, remarks, itemRows, saveEntry.isPending, autosaveSave.isPending]);

  // ---- duplicate-transaction warnings (server window; informational) ----
  const dupItemsParam = React.useMemo(
    () =>
      Array.from(
        new Map(
          itemRows
            .filter((r) => r.itemId && r.uomId && Number(r.quantity) > 0)
            .map((r) => [`${r.itemId}:${r.uomId}`, `${r.itemId}:${Number(r.quantity)}:${r.uomId}`])
        ).values()
      ).join(","),
    [itemRows]
  );
  const dupCheck = useQuery({
    queryKey: ["entry-dup-check", importerId, checkpointId, dupItemsParam],
    queryFn: () =>
      apiFetch<DuplicateCheckResponse>(
        `/api/entries/duplicate-check?importerId=${importerId}&checkpointId=${checkpointId}&items=${encodeURIComponent(dupItemsParam)}`
      ),
    enabled:
      formOpen && !dupDismissed && !!importerId && !!checkpointId && dupItemsParam.length > 0,
    staleTime: 15_000,
  });

  // ---- importer compact summary (retrieved — never re-typed) ----
  interface ImpSummaryStrip {
    importer: {
      importerCode: string;
      name: string;
      importerType: string;
      status: string;
      companyName: string | null;
    };
    group?: { code: string; name: string; representative?: { name: string; importerCode: string } | null } | null;
    subgroup?: { code: string; name: string } | null;
    quotas: {
      limitId: number;
      source: "INDIVIDUAL" | "GROUP";
      groupName: string | null;
      checkpoint: { id: number; name: string };
      periodType: string;
      allowedQuantity: number;
      uomSymbol: string;
      restriction: string | null;
      windowLabel: string | null;
      allowedBaseQuantity: number | null;
      approvedBaseQuantity: number | null;
      remainingBaseQuantity: number | null;
      overQuota: boolean;
      conversionError: boolean;
      perMember?: boolean;
      memberCount?: number | null;
      memberConsumed?: number | null;
      memberRemaining?: number | null;
    }[];
    today: { approvedEntries: number; approvedBaseQuantity: number; lastImportAt: string | null; lastCheckpointName: string | null };
  }
  const impStrip = useQuery({
    queryKey: ["importer-summary-strip", importerId],
    queryFn: () => apiFetch<ImpSummaryStrip>(`/api/importers/${importerId}/summary`),
    enabled: formOpen && !!importerId,
    staleTime: 15_000,
  });

  // ---- vehicle plate SUGGESTIONS (never auto-applied) ----
  const vehicleQ = useQuery({
    queryKey: ["vehicle-suggestions", importerId, checkpointId],
    queryFn: () =>
      apiFetch<{ plates: string[] }>(
        `/api/entries/vehicle-suggestions?importerId=${importerId}&checkpointId=${checkpointId}`
      ),
    enabled: formOpen && !!importerId,
    staleTime: 60_000,
  });

  // ---- COMPACT QUOTA RESOLUTION — ONE server call resolves the quota for
  // the WHOLE transaction (individual precedence over group) across all
  // valid rows. The same resolution runs inside the finalize transaction. ----
  const quotaRowsParam = React.useMemo(
    () =>
      Array.from(
        new Map(
          itemRows
            .filter((r) => r.itemId && r.uomId && Number(r.quantity) > 0)
            .map((r) => [`${r.itemId}:${r.uomId}`, `${r.itemId}:${Number(r.quantity)}:${r.uomId}`])
        ).values()
      ).join(","),
    [itemRows]
  );
  const quotaResolve = useQuery({
    queryKey: ["entry-quota-resolve", importerId, checkpointId, dateIso, quotaRowsParam],
    queryFn: () => {
       
      return apiFetch<ResolveResponse>(
        `/api/limits/resolve?importerId=${importerId}&checkpointId=${checkpointId}&date=${encodeURIComponent(dateIso ? new Date(dateIso).toISOString() : "")}&rows=${encodeURIComponent(quotaRowsParam)}`
      );
    },
    enabled: formOpen && !!importerId && !!checkpointId && quotaRowsParam.length > 0,
    staleTime: 5_000,
    refetchInterval: 15_000,
  });

  // STRICT QUOTA RULE: a transaction whose total exceeds the remaining
  // shared balance can NEVER be finalized (server enforces the same rule).
  const overQuotaBlocked =
    quotaResolve.data?.resolution.status === "resolved" &&
    quotaResolve.data.resolution.projectedExcess > 0;

  // Validates the form and returns an inline-errors map (same pattern as limits-view)
  const validateForm = (action: "draft" | "submit"): Record<string, string | undefined> => {
    const next: Record<string, string | undefined> = {};
    if (!importerId) next.importerId = "لطفاً واردکننده را انتخاب کنید.";
    if (!checkpointId) next.checkpointId = "لطفاً بندر را انتخاب کنید.";
    if (!dateIso) {
      next.dateIso = "لطفاً تاریخ واردات را انتخاب کنید.";
    } else if (!buildDatetime()) {
      next.timeText = "ساعت واردات نامعتبر است. نمونه درست: ۰۸:۳۰";
    }
    const filled = itemRows.filter((r) => r.itemId);
    if (!filled.length) next.items = "لطفاً حداقل یک جنس اضافه کنید.";
    for (let idx = 0; idx < itemRows.length; idx++) {
      const r = itemRows[idx];
      if (!r.itemId) continue;
      if (!r.quantity || Number(r.quantity) <= 0)
        next[`items.${idx}.quantity`] = "لطفاً مقدار همه اجناس را درست بنویسید.";
      if (!r.uomId)
        next[`items.${idx}.uomId`] = "لطفاً واحد اندازه‌گیری همه اجناس را انتخاب کنید.";
    }
    if (action === "submit") {
      // Duplicate line items (same itemId + uomId) block finalization.
      const seen = new Set<string>();
      for (let idx = 0; idx < itemRows.length; idx++) {
        const r = itemRows[idx];
        if (!r.itemId || !r.uomId) continue;
        const key = `${r.itemId}|${r.uomId}`;
        if (seen.has(key)) {
          next[`items.${idx}.itemId`] = "این جنس با همین واحد قبلاً اضافه شده است.";
        }
        seen.add(key);
      }
      // STRICT: exceeding the remaining quota is never permitted — the
      // quantity must be reduced to fit the balance (same rule the server
      // enforces inside the finalize transaction). GROUP quotas are
      // PER-MEMBER: the registering member's own remaining is the bound.
      const res = quotaResolve.data?.resolution;
      if (res?.status === "resolved" && res.projectedExcess > 0) {
        const remaining = res.memberUsage ? res.memberUsage.remainingBefore : res.usage.available;
        next.overQuota = `ثبت بیش از حد مجاز مجاز نیست — باقی‌مانده سهمیه: ${formatNumber(remaining)} ${res.quota.uomSymbol} — مقدار درخواستی: ${formatNumber(res.totalCharge)} ${res.quota.uomSymbol}. لطفاً مقدار را تا حداکثر باقی‌مانده کاهش دهید.`;
      }
    }
    return next;
  };

  const handleSave = (action: "draft" | "submit") => {
    const next = validateForm(action);
    setErrors(next);
    if (Object.values(next).some(Boolean)) {
      // Focus the first invalid field for fast correction.
      const firstInvalid = document.querySelector<HTMLElement>("[aria-invalid='true']");
      firstInvalid?.focus();
      return;
    }
    // Direct registration — no approval step, no extra confirmation for a
    // valid transaction (quota impact is visible live in the summary).
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    manualSaveRef.current = true;
    saveEntry.mutate(action);
  };

  // ---- validation summary panel (one actionable line per problem) ----
  const errorLines = React.useMemo(() => {
    const lines: string[] = [];
    if (errors.importerId) lines.push("واردکننده را انتخاب کنید.");
    if (errors.checkpointId) lines.push("بندر را انتخاب کنید.");
    if (errors.dateIso) lines.push("تاریخ واردات را انتخاب کنید.");
    if (errors.timeText) lines.push("ساعت واردات را درست بنویسید (نمونه: 08:30).");
    if (errors.items) lines.push(errors.items);
    itemRows.forEach((r, idx) => {
      const item = activeItems.find((i) => String(i.id) === r.itemId);
      const label = item ? `«${item.itemName}»` : `قلم ${toPersianDigits(idx + 1)}`;
      if (errors[`items.${idx}.itemId`]) lines.push(`${label}: این جنس با همین واحد قبلاً اضافه شده است.`);
      if (errors[`items.${idx}.quantity`]) lines.push(`مقدار جنس ${label} باید بزرگ‌تر از صفر باشد.`);
      if (errors[`items.${idx}.uomId`]) lines.push(`واحد اندازه‌گیری جنس ${label} را انتخاب کنید.`);
    });
    if (errors.overQuota) lines.push(errors.overQuota);
    return lines;
  }, [errors, itemRows, activeItems]);

  // ---- workflow mutations ----
  const submitEntry = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/entries/${id}/submit`, { method: "POST" }),
    onSuccess: () => {
      toast.success("ثبت واردات نهایی شد و سهمیه به‌روز شد.");
      queryClient.invalidateQueries({ queryKey: ["entries"] });
      queryClient.invalidateQueries({ queryKey: ["entry-detail"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      setSubmitTarget(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteEntry = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/entries/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("ثبت مسوده حذف شد.");
      queryClient.invalidateQueries({ queryKey: ["entries"] });
      setDeleteTarget(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reverseEntry = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/entries/${id}/reverse`, {
        method: "POST",
        body: JSON.stringify({ remarks: reverseReason }),
      }),
    onSuccess: () => {
      toast.success("ثبت واردات ابطال شد؛ سهمیه مصرف‌شده آزاد گردید.");
      queryClient.invalidateQueries({ queryKey: ["entries"] });
      queryClient.invalidateQueries({ queryKey: ["entry-detail"] });
      queryClient.invalidateQueries({ queryKey: ["limits-quotas"] });
      setReverseTarget(null);
      setReverseReason("");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const canActOn = (entry: EntryRow) =>
    entry.creator?.id === user?.id || user?.role === "ADMIN";

  const openReverseDialog = (entry: EntryRow) => {
    setReverseTarget(entry);
    setReverseReason("");
    setReverseError(undefined);
  };

  const detailEntry = detail.data?.entry;
  const allEntries = entries.data?.entries ?? [];
  const { sorted, sort, toggleSort } = useSortedRows<EntryRow>(
    allEntries,
    React.useMemo(
      () => ({
        entryNumber: (r) => r.entryNumber,
        date: (r) => r.importDatetime,
      }),
      []
    )
  );
  const paging = usePagedRows(sorted, 15);

  // ---- terminal biometric import listener (live scan → create form) ----
  // The SSE stream is CLOSED (not just muted) whenever a conflicting
  // dialog owns the screen: create/edit form, entry detail,
  // saved-success, and the confirm/reverse/delete prompts. It resumes
  // automatically afterwards.
  const listenerPaused =
    formOpen ||
    detailId !== null ||
    savedEntry !== null ||
    deleteTarget !== null ||
    reverseTarget !== null ||
    submitTarget !== null;

  return (
    <div>
      <PageHeader
        title={headerMeta.title}
        description={headerMeta.description}
        breadcrumbs={breadcrumbItems("entries")}
        actions={
          <>
            {canCreate && (
              <Button onClick={() => openCreate()}>
                <Plus className="size-4" aria-hidden />
                ثبت واردات جدید
              </Button>
            )}
            {!isNationwide && (
              <PortScopeChip isNationwide={false} checkpointName={user?.checkpointName} />
            )}
          </>
        }
      />

      <TableShell
        toolbar={
          <>
            {/* Status tabs — one-click switching */}
            <div className="mb-3 overflow-x-auto no-print">
              <Tabs value={statusFilter} onValueChange={setStatusFilter}>
                <TabsList className="h-9">
                  <TabsTrigger value="all">همه</TabsTrigger>
                  <TabsTrigger value="DRAFT">مسوده</TabsTrigger>
                  <TabsTrigger value="APPROVED">ثبت‌شده</TabsTrigger>
                  <TabsTrigger value="REVERSED">ابطال‌شده</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            <TableToolbar value={q} onChange={setQ} placeholder="جستجو بر اساس نمبر ثبت…">
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
                  importersQ.data?.importers,
                  (i) => i.id,
                  (i) => i.name
                )}
                placeholder={groupFilter ? "همه اعضای گروپ" : "همه واردکنندگان"}
                searchPlaceholder="جستجوی واردکننده…"
                loading={importersQ.isLoading}
                allowClear
                className="sm:w-56"
              />
              {isNationwide ? (
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
                <PortScopeChip
                  isNationwide={false}
                  checkpointName={user?.checkpointName}
                  className="sm:w-48"
                />
              )}
              {/* Live terminal scan → create-form bridge (SSE). Pauses
                  itself while the form/dialogs are open. */}
              {canCreate && (
                <TerminalImportListener
                  active={canCreate}
                  paused={listenerPaused}
                  onIdentified={(importerId) => openCreate(importerId)}
                />
              )}
            </TableToolbar>
          </>
        }
        footer={
          <TablePagination
            page={paging.page}
            pageCount={paging.pageCount}
            total={paging.total}
            onPage={paging.setPage}
            entityLabel="ثبت"
          />
        }
      >
        {entries.isLoading ? (
          <TableSkeleton rows={6} cols={8} />
        ) : !entries.data?.entries.length ? (
          <EmptyState
            icon={<FilePlus2 className="size-10" aria-hidden />}
            title="هیچ ثبت وارداتی یافت نشد"
            description={canCreate ? "ثبت واردات جدید را شروع کنید." : "هیچ رکوردی برای بندر شما موجود نیست."}
          />
        ) : (
          <Table className="min-w-[760px]">
            <TableHeader className="sticky top-0 z-10 bg-muted">
              <TableRow>
                <SortHead label="نمبر ثبت" k="entryNumber" sort={sort} onSort={toggleSort} />
                <SortHead label="تاریخ و ساعت" k="date" sort={sort} onSort={toggleSort} />
                <TableHead>واردکننده</TableHead>
                <TableHead className="hidden md:table-cell">بندر</TableHead>
                <TableHead>اجناس</TableHead>
                <TableHead className="hidden md:table-cell">ثبت‌کننده</TableHead>
                <TableHead>وضعیت</TableHead>
                <TableHead className="no-print text-center">عملیات</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paging.paged.map((entry) => {
                const firstItem = entry.items[0];
                const extraItems = entry.items.length - 1;
                const itemsSummary = entry.items
                  .map((i) => `${i.item.itemName}: ${formatNumber(i.quantity)} ${i.uom.symbol}`)
                  .join("، ");
                return (
                  <TableRow key={entry.id} className="hover:bg-muted/40">
                    <TableCell className="font-mono text-xs font-medium">{entry.entryNumber}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      {formatJalaliDateTime(entry.importDatetime)}
                    </TableCell>
                    <TableCell>
                      <div className="font-medium text-sm max-w-48 truncate" title={entry.importer.name}>
                        {entry.importer.name}
                      </div>
                      <div className="text-xs text-muted-foreground tabular-nums max-w-48 truncate">
                        {entry.importer.importerCode}
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <Badge variant="outline" className="bg-muted/60">
                        {entry.checkpoint.name}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs max-w-72">
                      <div className="flex items-baseline gap-1 min-w-0">
                        <span className="truncate" title={itemsSummary}>
                          {firstItem
                            ? `${firstItem.item.itemName}: ${formatNumber(firstItem.quantity)} ${firstItem.uom.symbol}`
                            : "—"}
                        </span>
                        {extraItems > 0 && (
                          <span className="text-primary whitespace-nowrap shrink-0">
                            +{toPersianDigits(extraItems)}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                      {entry.creator?.name ?? "—"}
                    </TableCell>
                    <TableCell>
                      <EntryStatusBadge status={entry.status} />
                    </TableCell>
                    <TableCell className="no-print">
                      <div className="flex justify-center">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" aria-label={`عملیات ثبت ${entry.entryNumber}`}>
                              <MoreHorizontal className="size-4" aria-hidden />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="start" className="w-52">
                            <DropdownMenuItem onSelect={() => setDetailId(entry.id)}>
                              <Eye className="size-4" aria-hidden />
                              مشاهده
                            </DropdownMenuItem>
                            {entry.status === "DRAFT" && canActOn(entry) && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onSelect={() => setSubmitTarget(entry)}>
                                  <FileUp className="size-4" aria-hidden />
                                  ثبت نهایی
                                </DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => openEdit(entry)}>
                                  <Pencil className="size-4" aria-hidden />
                                  ویرایش مسوده
                                </DropdownMenuItem>
                                <DropdownMenuItem variant="destructive" onSelect={() => setDeleteTarget(entry)}>
                                  <Trash2 className="size-4" aria-hidden />
                                  حذف مسوده
                                </DropdownMenuItem>
                              </>
                            )}
                            {entry.status === "APPROVED" && canReverse && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem variant="destructive" onSelect={() => openReverseDialog(entry)}>
                                  <Undo2 className="size-4" aria-hidden />
                                  ابطال ثبت‌شده
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </TableShell>

      {/* ============ Create / edit dialog ============ */}
      <FormDialog
        open={formOpen}
        onOpenChange={(v) => {
          if (!v) {
            setFormOpen(false);
            setSavedEntry(null);
          }
        }}
        title={
          savedEntry
            ? "ثبت واردات نهایی شد"
            : editingEntry
              ? `ویرایش ثبت مسوده — ${editingEntry.entryNumber}`
              : "ثبت واردات جدید"
        }
        description={
          savedEntry
            ? "سهمیه مصرف‌شده به‌روز شد؛ این ثبت دیگر قابل ویرایش نیست (فقط ابطال با دلیل)."
            : "با انتخاب واردکننده، بندر و جنس، سهمیه باقی‌مانده به‌صورت خودکار محاسبه می‌شود."
        }
        icon={
          savedEntry ? (
            <CheckCircle2 className="size-5 text-success" aria-hidden />
          ) : (
            <FilePlus2 className="size-5 text-primary" aria-hidden />
          )
        }
        size="lg"
        busy={saveEntry.isPending}
        dirty={dirty && !savedEntry}
        onSubmit={
          savedEntry
            ? undefined
            : () => {
                // Direct registration: no extra confirmation for a valid
                // transaction — the quota impact is live in the summary.
                if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
                manualSaveRef.current = true;
                handleSave("submit");
              }
        }
        submitLabel="ثبت واردات"
        submitDisabled={saveEntry.isPending || overQuotaBlocked}
        footer={
          savedEntry ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                const id = savedEntry.id;
                setSavedEntry(null);
                setDetailId(id);
              }}
            >
              <Eye className="size-4" aria-hidden />
              مشاهده ثبت
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              onClick={() => handleSave("draft")}
              disabled={saveEntry.isPending}
            >
              ذخیره مسوده
            </Button>
          )
        }
      >
        {savedEntry ? (
          /* ============ SUCCESS PANEL (same dialog — no stacking) ============ */
          <EntrySuccessPanel
            entry={savedEntry}
            sameImporter={sameImporterNext}
            onSameImporterChange={setSameImporterNext}
            onRegisterAnother={(keepImporter) => {
              setSavedEntry(null);
              openCreate(keepImporter ? savedEntry.importer.id : undefined);
            }}
          />
        ) : (
        <>
        {/* AUTOSAVE indicator — saving / saved / failed states */}
        {autosaveStatus !== "idle" && !editingEntry && (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground" role="status">
            {autosaveStatus === "saving" && (
              <>
                <Loader2 className="size-3 animate-spin" aria-hidden />
                ذخیره خودکار مسوده…
              </>
            )}
            {autosaveStatus === "saved" && (
              <>
                <CheckCircle2 className="size-3 text-success" aria-hidden />
                مسوده به‌صورت خودکار ذخیره شد — در صورت قطع شدن می‌توانید بعداً ادامه دهید.
              </>
            )}
            {autosaveStatus === "failed" && (
              <>
                <CircleAlert className="size-3 text-danger" aria-hidden />
                ذخیره خودکار ناموفق بود — اطلاعات شما محفوظ است؛ دوباره تلاش می‌شود.
              </>
            )}
          </div>
        )}

        {/* Validation summary — Preline callout, one actionable Dari line per problem */}
        {errorLines.length > 0 && (
          <PlAlert tone="danger" title="لطفاً خطاهای زیر را برطرف کنید" role="alert">
            <ul>
              {errorLines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </PlAlert>
        )}

        {/* ۱ • Importer, port, date & time */}
        <FormSection title="۱ • واردکننده و بندر">
          <div className="space-y-1.5 min-w-0">
            <Label htmlFor="entry-importer">واردکننده *</Label>
            <SearchSelect
              id="entry-importer"
              value={importerId || null}
              onChange={(v) => {
                
                setImporterId(v ?? "");
                setDirty(true);
                clearError("importerId");
              }}
              options={toOptions(
                activeImporters,
                (i) => i.id,
                (i) => i.name,
                (i) => [i.importerCode, IMPORTER_TYPE_LABELS[i.importerType] ?? null].filter(Boolean).join(" • ")
              )}
              placeholder="انتخاب واردکننده"
              searchPlaceholder="جستجوی واردکننده…"
              loading={importersQ.isLoading}
              invalid={!!errors.importerId}
            />
            {errors.importerId && <FieldError message={errors.importerId} />}
            {/* COMPACT SUMMARY — retrieved from the record, never re-typed */}
            {importerId && impStrip.data && (
              <div className="mt-1.5 rounded-lg border bg-muted/40 p-2.5 space-y-1.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  <span className="font-mono font-bold" dir="ltr">{impStrip.data.importer.importerCode}</span>
                  <span className="font-medium">{impStrip.data.importer.name}</span>
                  <span className="text-muted-foreground">
                    {IMPORTER_TYPE_LABELS[impStrip.data.importer.importerType] ?? impStrip.data.importer.importerType}
                  </span>
                  {impStrip.data.importer.status !== "ACTIVE" && (
                    <Badge variant="outline" className="bg-danger-soft text-danger border-danger/30">غیرفعال</Badge>
                  )}
                </div>
                {impStrip.data.group && (
                  <div className="text-[11px] text-muted-foreground">
                    گروپ: {impStrip.data.group.name} (<span dir="ltr" className="font-mono">{impStrip.data.group.code}</span>)
                    {impStrip.data.group.representative && (
                      <> — نماینده: {impStrip.data.group.representative.name} (<span dir="ltr" className="font-mono">{impStrip.data.group.representative.importerCode}</span>)</>
                    )}
                    {impStrip.data.subgroup && <> — زیرگروپ: {impStrip.data.subgroup.name}</>}
                  </div>
                )}
                <div className="text-[11px] text-muted-foreground">
                  واردات امروز: {toPersianDigits(impStrip.data.today.approvedEntries)} ثبت
                  {impStrip.data.today.lastImportAt && (
                    <> — آخرین ثبت: {formatJalaliDateTime(impStrip.data.today.lastImportAt)}{impStrip.data.today.lastCheckpointName ? ` (${impStrip.data.today.lastCheckpointName})` : ""}</>
                  )}
                </div>
                {impStrip.data.quotas.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-0.5">
                    {impStrip.data.quotas.slice(0, 4).map((qt) => {
                      // GROUP quota = PER-MEMBER allowance — the strip shows
                      // THIS member's own remaining, never the pooled total.
                      const remaining = qt.perMember
                        ? (qt.memberRemaining ?? qt.allowedQuantity)
                        : qt.remainingBaseQuantity ?? 0;
                      return (
                        <QuotaPill
                          key={qt.limitId}
                          label={`${qt.source === "GROUP" ? `گروپ: ${qt.groupName ?? "—"} (هر عضو)` : "فردی"} (${PERIOD_LABELS[qt.periodType] ?? qt.periodType})`}
                          value={qt.conversionError ? "تبدیل تعریف نشده" : `باقی: ${formatNumber(remaining)} ${qt.uomSymbol}`}
                          tone={qt.overQuota ? "danger" : remaining <= 0 ? "warn" : "ok"}
                        />
                      );
                    })}
                    {impStrip.data.quotas.length > 4 && (
                      <span className="text-[10px] text-muted-foreground self-center">
                        +{toPersianDigits(impStrip.data.quotas.length - 4)} سهمیه دیگر
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="space-y-1.5 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="entry-checkpoint">بندر *</Label>
              {isPortLocked && (
                <span className="text-[10px] text-warning bg-warning-soft border border-warning/30 rounded px-1.5 py-0.5">
                  بندر مسئولیت شما — غیرقابل تغییر
                </span>
              )}
            </div>
            <SearchSelect
              id="entry-checkpoint"
              value={checkpointId || null}
              onChange={(v) => {
                if (isPortLocked) return;
                setCheckpointId(v ?? "");
                setDirty(true);
                clearError("checkpointId");
              }}
              disabled={isPortLocked}
              disabledHint={
                isPortLocked && user?.checkpointName ? `بندر مسئولیت شما: ${user.checkpointName}` : undefined
              }
              options={toOptions(
                activeCheckpoints,
                (c) => c.id,
                (c) => c.name,
                (c) => c.province
              )}
              placeholder="انتخاب بندر"
              searchPlaceholder="جستجوی بندر…"
              loading={checkpointsQ.isLoading}
              invalid={!!errors.checkpointId}
            />
            {errors.checkpointId && <FieldError message={errors.checkpointId} />}
          </div>
          <div className="space-y-1.5 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <Label>تاریخ واردات</Label>
              <span className="inline-flex items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                <Lock className="size-3" aria-hidden />
                خودکار
              </span>
            </div>
            {/* READONLY — تاریخ ثبت همان روز کابل است؛ توسط سیستم تکمیل می‌شود
                و برای جلوگیری از خطای انسانی قابل ویرایش نیست. */}
            <div
              className="flex h-9 items-center gap-2 rounded-md border bg-muted/40 px-3 text-sm"
              aria-readonly="true"
            >
              <CalendarDays className="size-4 text-gold shrink-0" aria-hidden />
              <span className="tabular-nums" suppressHydrationWarning>
                {dateIso ? formatJalali(new Date(dateIso)) : "—"}
              </span>
            </div>
          </div>
          <div className="space-y-1.5 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="entry-time">ساعت</Label>
              <span className="inline-flex items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                <Lock className="size-3" aria-hidden />
                خودکار
              </span>
            </div>
            {/* READONLY — ساعت ثبت هنگام باز شدن فرم قفل می‌شود. */}
            <div
              className="flex h-9 items-center gap-2 rounded-md border bg-muted/40 px-3 text-sm"
              aria-readonly="true"
            >
              <Clock className="size-4 text-gold shrink-0" aria-hidden />
              <span className="tabular-nums" dir="ltr" suppressHydrationWarning>
                {timeText || "—"}
              </span>
            </div>
            <p className="text-[10px] text-muted-foreground">
              تاریخ و ساعت ثبت به‌صورت خودکار درج می‌شود و قابل تغییر نیست.
            </p>
          </div>
        </FormSection>

        {/* ۲ • Vehicle & remarks */}
        <FormSection title="۲ • وسیله و ملاحظات">
          <div className="space-y-1.5 min-w-0">
            <Label htmlFor="entry-vehicle">پلاک موتر (اختیاری)</Label>
            <Input
              id="entry-vehicle"
              list="vehicle-plate-options"
              value={vehicleNumber}
              onChange={(e) => {
                setVehicleNumber(e.target.value);
                setDirty(true);
              }}
              placeholder="مثلاً جلال‌آباد ۴۵۲۱"
            />
            {/* Previously used plates are SUGGESTIONS only — a plate is
                never applied automatically. */}
            {(vehicleQ.data?.plates?.length ?? 0) > 0 && (
              <datalist id="vehicle-plate-options">
                {vehicleQ.data!.plates.map((plate) => (
                  <option key={plate} value={plate} />
                ))}
              </datalist>
            )}
            {(vehicleQ.data?.plates?.length ?? 0) > 0 && (
              <p className="text-[10px] text-muted-foreground">پلاک‌های قبلاً استفاده‌شده این واردکننده در پیشنهادها موجود است.</p>
            )}
          </div>
          <div className="space-y-1.5 min-w-0">
            <Label htmlFor="entry-remarks">ملاحظات</Label>
            <Input
              id="entry-remarks"
              value={remarks}
              onChange={(e) => {
                setRemarks(e.target.value);
                setDirty(true);
              }}
            />
          </div>
        </FormSection>

        {/* DUPLICATE-TRANSACTION WARNING — informational; a legitimate
            repeated shipment can be confirmed by the officer. */}
        {dupCheck.data && dupCheck.data.duplicates.length > 0 && !dupDismissed && (
          <PlAlert tone="warning" title="هشدار ثبت تکراری احتمالی" role="alert">
            <div className="space-y-1.5">
              <p className="text-xs">
                برای این واردکننده در {toPersianDigits(dupCheck.data.windowMinutes)} دقیقه اخیر ثبت مشابه موجود است:
              </p>
              <ul className="text-xs space-y-1">
                {dupCheck.data.duplicates.slice(0, 3).map((d) => (
                  <li key={d.id}>
                    <span className="font-mono" dir="ltr">{d.entryNumber}</span> — {formatJalaliDateTime(d.importDatetime)} —{" "}
                    {d.matchedItems.map((m) => `${m.itemName} (${formatNumber(m.quantity)} ${m.uom})`).join("، ")}
                  </li>
                ))}
              </ul>
              <p className="text-[11px] text-muted-foreground">
                اگر حمل واقعاً تکراری (بار جدید) است، ادامه دهید؛ در صورت اشتباه، ثبت موجود را از فهرست بررسی کنید.
              </p>
              <Button type="button" variant="outline" size="sm" onClick={() => setDupDismissed(true)}>
                ثبت جدید درست است — ادامه
              </Button>
            </div>
          </PlAlert>
        )}

        {/* ۳ • Items (repeatable rows with live quota) */}
        <FormSection title="۳ • اجناس وارداتی" columns={1}>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground">
              هر جنس با واحد مشخص فقط یک‌بار قابل ثبت است.
            </span>
            <Button type="button" variant="outline" size="sm" onClick={addItemRow}>
              <Plus className="size-3.5" aria-hidden />
              افزودن جنس
            </Button>
          </div>
          {errors.items && <FieldError message={errors.items} />}

          <div className="space-y-3">
            {itemRows.map((row, idx) => {
              const qtyErr = errors[`items.${idx}.quantity`];
              const uomErr = errors[`items.${idx}.uomId`];
              return (
                <div key={row.uid} className="rounded-lg border p-3 bg-muted/30 space-y-2">
                  <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
                    <div className="sm:col-span-4 space-y-1 min-w-0">
                      <Label htmlFor={`entry-item-${idx}`} className="text-xs">جنس *</Label>
                      <SearchSelect
                        id={`entry-item-${idx}`}
                        value={row.itemId || null}
                        onChange={(v) => {
                          const item = activeItems.find((i) => String(i.id) === v);
                          updateRow(idx, { itemId: v ?? "", uomId: item ? String(item.baseUomId) : "" });
                        }}
                        options={toOptions(
                          activeItems,
                          (i) => i.id,
                          (i) => i.itemName,
                          (i) => i.itemCode
                        )}
                        placeholder="انتخاب جنس"
                        searchPlaceholder="جستجوی جنس…"
                        loading={itemsQ.isLoading}
                      />
                      {duplicateRowUids.has(row.uid) && (
                        <FieldError message="این جنس با همین واحد قبلاً اضافه شده است." />
                      )}
                    </div>
                    <div className="sm:col-span-2 space-y-1 min-w-0">
                      <Label htmlFor={`entry-qty-${idx}`} className="text-xs">مقدار *</Label>
                      <Input
                        id={`entry-qty-${idx}`}
                        type="number"
                        min="0"
                        step="0.001"
                        dir="ltr"
                        className="text-left h-9"
                        value={row.quantity}
                        onChange={(e) => updateRow(idx, { quantity: e.target.value })}
                        aria-invalid={!!qtyErr}
                      />
                      {qtyErr && <FieldError message={qtyErr} />}
                    </div>
                    <div className="sm:col-span-3 space-y-1 min-w-0">
                      <Label htmlFor={`entry-uom-${idx}`} className="text-xs">واحد *</Label>
                      <SearchSelect
                        id={`entry-uom-${idx}`}
                        value={row.uomId || null}
                        onChange={(v) => updateRow(idx, { uomId: v ?? "" })}
                        options={toOptions(
                          activeUoms,
                          (u) => u.id,
                          (u) => u.name,
                          (u) => `(${u.symbol})`
                        )}
                        placeholder="واحد"
                        searchPlaceholder="جستجوی واحد…"
                        loading={uomsQ.isLoading}
                        invalid={!!uomErr}
                      />
                      {uomErr && <FieldError message={uomErr} />}
                    </div>
                    <div className="sm:col-span-3 flex items-end justify-start min-w-0">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-danger hover:text-danger h-9"
                        disabled={itemRows.length === 1}
                        onClick={() => removeItemRow(idx)}
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                        حذف سطر
                      </Button>
                    </div>
                  </div>

                </div>
              );
            })}
          </div>

          {/* ===== COMPACT QUOTA SUMMARY — one shared balance, all rows ===== */}
          <QuotaSummaryBox
            resolve={quotaResolve.data?.resolution}
            loading={quotaResolve.isLoading && quotaRowsParam.length > 0}
            importerId={importerId}
            checkpointId={checkpointId}
          />
        </FormSection>
        </>
        )}
      </FormDialog>

      {/* ============ Detail dialog ============ */}
      <FormDialog
        open={detailId !== null}
        onOpenChange={(v) => {
          if (!v) setDetailId(null);
        }}
        title="جزئیات ثبت واردات"
        size="lg"
        cancelLabel="بستن"
        footer={
          detailEntry && detailEntry.status === "APPROVED" && canReverse ? (
            <Button variant="destructive" size="sm" onClick={() => openReverseDialog(detailEntry)}>
              <Undo2 className="size-4" aria-hidden />
              ابطال ثبت‌شده
            </Button>
          ) : undefined
        }
      >
        {detail.isLoading || !detailEntry ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-8 rounded bg-muted animate-pulse" aria-hidden />
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
              <InfoField
                label="نمبر ثبت"
                value={<span className="font-mono" dir="ltr">{detailEntry.entryNumber}</span>}
              />
              <InfoField label="وضعیت" value={<EntryStatusBadge status={detailEntry.status} />} />
              <InfoField label="واردکننده" value={detailEntry.importer.name} />
              <InfoField label="بندر" value={detailEntry.checkpoint.name} />
              <InfoField label="تاریخ و ساعت واردات" value={formatJalaliDateTime(detailEntry.importDatetime)} />
              <InfoField label="پلاک موتر" value={detailEntry.vehicleNumber ?? "—"} />
              <InfoField label="ثبت‌کننده" value={detailEntry.creator?.name ?? "—"} />
              <InfoField
                label="تاریخ ثبت نهایی"
                value={
                  detailEntry.status === "APPROVED"
                    ? formatJalaliDateTime(detailEntry.approvedAt ?? detailEntry.updatedAt)
                    : "—"
                }
              />
              {detailEntry.remarks && <InfoField label="ملاحظات" value={detailEntry.remarks} span />}
            </div>

            <div className="rounded-xl border overflow-hidden">
              <Table>
                <TableHeader className="bg-muted">
                  <TableRow>
                    <TableHead>جنس</TableHead>
                    <TableHead className="text-center">مقدار</TableHead>
                    <TableHead className="text-center">مقدار اساس</TableHead>
                    <TableHead className="text-center">مصرف به واحد حد</TableHead>
                    <TableHead>حد مجاز</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detailEntry.items.map((it) => (
                    <TableRow key={it.id}>
                      <TableCell className="font-medium">
                        <div className="max-w-48 truncate" title={it.item.itemName}>
                          {it.item.itemName}
                        </div>
                      </TableCell>
                      <TableCell className="text-center">
                        {formatNumber(it.quantity)} {it.uom.symbol}
                      </TableCell>
                      <TableCell className="text-center text-xs text-muted-foreground">
                        {formatNumber(it.baseQuantity)} {it.item.baseUom.symbol}
                      </TableCell>
                      <TableCell className="text-center text-xs tabular-nums">
                        {it.quotaUomQuantity != null && it.importLimit
                          ? `${formatNumber(it.quotaUomQuantity)} ${it.importLimit.uom.symbol}${
                              it.quotaConversionFactor != null
                                ? ` (ضریب ${formatNumber(it.quotaConversionFactor)})`
                                : ""
                            }`
                          : "—"}
                      </TableCell>
                      <TableCell className="text-xs">
                        {it.importLimit
                          ? `${formatNumber(it.importLimit.allowedQuantity)} ${it.importLimit.uom.symbol} — ${PERIOD_LABELS[it.importLimit.periodType]}`
                          : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* legacy over-quota rows — kept ONLY for records created before
                strict enforcement; new registrations can never exceed */}
            {detailEntry.items.some((i) => i.exceptionReason) && (
              <div className="rounded-xl border border-warning/30 bg-warning-soft p-3 space-y-2">
                <div className="font-semibold text-sm text-warning flex items-center gap-1.5">
                  <AlertTriangle className="size-4" aria-hidden />
                  ثبت بیش از حد مجاز (سابقه — دیگر ثبت نمی‌شود)
                </div>
                {detailEntry.items
                  .filter((i) => i.exceptionReason)
                  .map((i) => (
                    <div
                      key={i.id}
                      className="text-xs space-y-1 border-t border-warning/30 pt-1.5 first:border-0 first:pt-0"
                    >
                      <div className="font-medium text-foreground">{i.item.itemName}</div>
                      <div>دلیل: {i.exceptionReason}</div>
                      <div>
                        ثبت‌کننده: {i.exceptionRequester?.name ?? "—"}
                        {i.exceptionApprover ? ` — تأییدکننده: ${i.exceptionApprover.name}` : ""}
                        {i.exceptionRejecter ? ` — ردکننده: ${i.exceptionRejecter.name}` : ""}
                      </div>
                    </div>
                  ))}
              </div>
            )}

            {/* actions timeline */}
            {detailEntry.actions && detailEntry.actions.length > 0 && (
              <div>
                <div className="font-semibold text-sm mb-1.5">سابقه عملیات</div>
                <div className="space-y-1.5 max-h-40 overflow-y-auto pe-1">
                  {detailEntry.actions.map((a) => (
                    <div key={a.id} className="flex items-start gap-2 text-xs border-b pb-1.5 last:border-0">
                      <Badge variant="outline" className="bg-muted/60 shrink-0">
                        {ACTION_LABELS[a.actionType] ?? a.actionType}
                      </Badge>
                      <div className="min-w-0">
                        <span className="font-medium">{a.actor.name}</span>
                        <span className="text-muted-foreground"> — {formatJalaliDateTime(a.actionAt)}</span>
                        {a.remarks && <div className="text-muted-foreground">{a.remarks}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </FormDialog>

      {/* finalize confirm (from the list, for own DRAFTs) */}
      <ConfirmDialog
        open={submitTarget !== null}
        onOpenChange={(v) => !v && setSubmitTarget(null)}
        title="ثبت نهایی واردات"
        description={`آیا ثبت «${submitTarget?.entryNumber}» نهایی شود؟ سهمیه واردکننده به‌صورت قطعی مصرف می‌شود و ویرایش ممکن نیست.`}
        confirmLabel="ثبت نهایی"
        busy={submitEntry.isPending}
        onConfirm={() => submitTarget && submitEntry.mutate(submitTarget.id)}
      />

      {/* delete confirm */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        title="حذف ثبت مسوده"
        description={`آیا ثبت مسوده «${deleteTarget?.entryNumber}» حذف شود؟ این عمل قابل بازگشت نیست.`}
        confirmLabel="حذف"
        destructive
        busy={deleteEntry.isPending}
        onConfirm={() => deleteTarget && deleteEntry.mutate(deleteTarget.id)}
      />

      {/* reverse dialog */}
      <Dialog open={reverseTarget !== null} onOpenChange={(v) => !v && setReverseTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>ابطال ثبت تأییدشده</DialogTitle>
            <DialogDescription>
              ابطال «{reverseTarget?.entryNumber}» مقدار تأییدشده را از سهمیه آزاد می‌کند. این عملیه در سابقه سیستم ثبت می‌شود.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="reverse-reason">دلیل ابطال *</Label>
            <Textarea
              id="reverse-reason"
              rows={3}
              value={reverseReason}
              onChange={(e) => {
                setReverseReason(e.target.value);
                setReverseError(undefined);
              }}
              placeholder="مثلاً: اشتباه در مقدار ثبت‌شده"
              aria-invalid={!!reverseError}
            />
            {reverseError && <FieldError message={reverseError} />}
          </div>
          <DialogFooter className="flex-row justify-start gap-2">
            <Button
              variant="destructive"
              disabled={reverseEntry.isPending}
              onClick={() => {
                if (reverseReason.trim().length < 3) {
                  setReverseError("لطفاً دلیل ابطال را بنویسید.");
                  return;
                }
                if (reverseTarget) reverseEntry.mutate(reverseTarget.id);
              }}
            >
              {reverseEntry.isPending ? "در حال ابطال..." : "ابطال ثبت"}
            </Button>
            <Button variant="outline" onClick={() => setReverseTarget(null)}>
              لغو
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}

// ============================================================
// QuotaSummaryBox — COMPACT feedback for the whole transaction:
// quota owner/source, authorized, consumed, current request (ALL rows)
// and projected remaining — in ONE summary. Details expand only when
// there is a conflict, missing quota, incompatible unit or excess.
// ============================================================

function QuotaSummaryBox({
  resolve,
  loading,
  importerId,
  checkpointId,
}: {
  resolve: ResolveResponse["resolution"] | undefined;
  loading: boolean;
  importerId: string;
  checkpointId: string;
}) {
  if (!importerId || !checkpointId) return null;
  if (loading) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground py-2">
        <Loader2 className="size-3.5 animate-spin" aria-hidden /> در حال محاسبه سهمیه…
      </div>
    );
  }
  if (!resolve) return null;

  if (resolve.status !== "resolved") {
    return (
      <div className="rounded-lg border border-danger/30 bg-danger-soft p-3 text-xs text-danger space-y-1">
        <div className="font-semibold flex items-center gap-1.5">
          <AlertTriangle className="size-4" aria-hidden />
          {resolve.status === "missing" ? "حد مجاز موجود نیست" : resolve.status === "conflict" ? "تداخل پیکربندی حد مجاز" : "این ثبت با حد مجاز فعلی قابل پوشش نیست"}
        </div>
        <p>{resolve.reason}</p>
      </div>
    );
  }

  const r = resolve;
  const isGroup = r.source === "GROUP";
  // GROUP quota = PER-MEMBER allowance — show the REGISTERING member's
  // own numbers; the other members never cover this transaction.
  const consumedShown = r.memberUsage ? r.memberUsage.consumedBefore : r.usage.consumed;
  const availableShown = r.memberUsage ? r.memberUsage.remainingBefore : r.usage.available;
  const sourceLabel = isGroup
    ? `حد مجاز گروپ: ${r.quota.groupName ?? "—"} — سهم هر عضو`
    : "حد مجاز فردی";

  return (
    <div className="rounded-lg border bg-muted/40 p-3 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold text-foreground">{sourceLabel}</span>
        <span className="text-[10px] text-muted-foreground">{r.usage.windowLabel}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <QuotaPill
          label={isGroup ? "مجاز (هر عضو)" : "مجاز"}
          value={`${formatNumber(r.quota.allowedQuantity)} ${r.quota.uomSymbol}`}
        />
        <QuotaPill
          label={isGroup ? "مصرف‌شده این عضو" : "مصرف‌شده"}
          value={`${formatNumber(consumedShown)} ${r.quota.uomSymbol}`}
          tone="default"
        />
        <QuotaPill
          label="این ثبت"
          value={`${formatNumber(r.totalCharge)} ${r.quota.uomSymbol}`}
          tone={r.withinQuota ? "ok" : "danger"}
        />
        <QuotaPill
          label={r.withinQuota ? "باقی‌مانده پس از ثبت" : "مقدار اضافی"}
          value={
            r.withinQuota
              ? `${formatNumber(r.projectedRemaining)} ${r.quota.uomSymbol}`
              : `+${formatNumber(r.projectedExcess)} ${r.quota.uomSymbol}`
          }
          tone={r.withinQuota ? "ok" : "danger"}
        />
      </div>

      {/* STRICT RULE: exceeding the quota is never allowed — the quantity
          must fit the remaining balance; the server rejects otherwise. */}
      {!r.withinQuota && (
        <div className="rounded-md border border-danger/30 bg-danger-soft p-2.5 text-xs text-danger space-y-1" role="alert">
          <div className="font-semibold flex items-center gap-1.5">
            <AlertTriangle className="size-4" aria-hidden />
            ثبت بیش از حد مجاز مجاز نیست
          </div>
          <p>
            باقی‌مانده سهمیه: {formatNumber(availableShown)} {r.quota.uomSymbol} — مقدار درخواستی: {formatNumber(r.totalCharge)} {r.quota.uomSymbol} — مقدار اضافی: {formatNumber(r.projectedExcess)} {r.quota.uomSymbol}
          </p>
          <p>
            لطفاً مقدار اجناس را تا حداکثر باقی‌مانده ({formatNumber(availableShown)} {r.quota.uomSymbol}) کاهش دهید؛ در غیر این صورت دکمه «ثبت واردات» فعال نمی‌شود.
          </p>
        </div>
      )}
    </div>
  );
}

// ============================================================
// EntrySuccessPanel — rendered INSIDE the create dialog (no stacked
// dialogs): saved number, resulting balances (server-computed for each
// finalized item) and clear next actions. "Register another" retains
// ONLY the working context the user explicitly confirms.
// ============================================================

function EntrySuccessPanel({
  entry,
  sameImporter,
  onSameImporterChange,
  onRegisterAnother,
}: {
  entry: EntryRow;
  sameImporter: boolean;
  onSameImporterChange: (v: boolean) => void;
  onRegisterAnother: (keepImporter: boolean) => void;
}) {
  // Resulting balances for every DISTINCT item of this entry — live,
  // server-computed quota (never client math). The entry is APPROVED in
  // the database, so its own consumption is already included.
  const distinctItems = React.useMemo(() => {
    const seen = new Map<number, string>();
    for (const it of entry.items) {
      if (!seen.has(it.itemId)) seen.set(it.itemId, it.item.itemName);
    }
    return Array.from(seen.entries()).slice(0, 5);
  }, [entry.items]);

  // The entry is APPROVED — its charge is already part of the committed
  // balance, so `usage.available` IS the remaining-after-registration.
  const balanceQ = useQuery({
    queryKey: ["entry-success-balances", entry.id, entry.checkpoint.id],
    queryFn: async () => {
      const rows = entry.items
        .filter((it) => it.quantity > 0)
        .map((it) => `${it.itemId}:${it.quantity}:${it.uomId}`)
        .join(",");
      const r = await apiFetch<ResolveResponse>(
        `/api/limits/resolve?importerId=${entry.importer.id}&checkpointId=${entry.checkpoint.id}&date=${new Date(entry.importDatetime).toISOString()}&rows=${encodeURIComponent(rows)}`
      );
      return r.resolution;
    },
    staleTime: 10_000,
  });

  return (
    <div className="space-y-3">
      <div className="rounded-lg border bg-muted/40 px-3 py-2.5 flex items-center justify-between">
        <div>
          <div className="text-xs text-muted-foreground">نمبر ثبت (خودکار)</div>
          <div className="font-mono text-base font-bold" dir="ltr">{entry.entryNumber}</div>
        </div>
        <Badge variant="outline" className="bg-success-soft text-success border-success/30">
          {ENTRY_STATUS_LABELS[entry.status] ?? entry.status}
        </Badge>
      </div>

      <div className="text-xs text-muted-foreground">
        واردکننده: <span className="font-medium text-foreground">{entry.importer.name}</span> ({entry.importer.importerCode}) — بندر: {entry.checkpoint.name} — {formatJalaliDateTime(entry.importDatetime)}
      </div>

      <div className="rounded-lg border p-3 space-y-1.5">
        <div className="text-xs font-semibold">موجودی باقی‌مانده پس از این ثبت</div>
        {balanceQ.isLoading && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground py-1">
            <Loader2 className="size-3 animate-spin" aria-hidden /> در حال محاسبه…
          </div>
        )}
        {balanceQ.data?.status === "resolved" ? (
          (() => {
            const b = balanceQ.data;
            const isGroup = b.source === "GROUP";
            // GROUP quota = PER-MEMBER allowance — the member's own numbers
            // (the entry is APPROVED, so its charge is already included).
            const consumedShown = b.memberUsage ? b.memberUsage.consumedBefore : b.usage.consumed;
            const remainingShown = b.memberUsage ? b.memberUsage.remainingBefore : b.usage.available;
            return (
              <>
                <div className="text-xs text-muted-foreground">
                  {isGroup
                    ? `حد مجاز گروپ: ${b.quota.groupName ?? "—"} — سهم هر عضو`
                    : "حد مجاز فردی"}
                  {" — "}
                  {b.usage.windowLabel}
                </div>
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span>
                    مجاز: {formatNumber(b.quota.allowedQuantity)} {b.quota.uomSymbol} — مصرف‌شده: {formatNumber(consumedShown)} {b.quota.uomSymbol}
                  </span>
                  <QuotaPill
                    label="باقی‌مانده"
                    value={`${formatNumber(remainingShown)} ${b.quota.uomSymbol}`}
                    tone={b.usage.excess > 0 ? "danger" : remainingShown <= 0 ? "warn" : "ok"}
                  />
                </div>
              </>
            );
          })()
        ) : balanceQ.data ? (
          <div className="text-xs text-muted-foreground">
            {balanceQ.data.status === "missing"
              ? "حد مجاز فعالی برای این ترکیب وجود ندارد."
              : balanceQ.data.reason}
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between rounded-lg border px-3 py-2">
          <span className="text-xs font-medium">ثبت واردات دیگر برای همین واردکننده</span>
          <Switch
            checked={sameImporter}
            onCheckedChange={onSameImporterChange}
            aria-label="همین واردکننده"
          />
        </div>
        <Button onClick={() => onRegisterAnother(sameImporter)}>
          <RotateCcw className="size-4" aria-hidden />
          ثبت واردات جدید
        </Button>
      </div>
    </div>
  );
}

export { EntriesView };
