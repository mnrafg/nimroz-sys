"use client";

import * as React from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Eye, FilePlus2, Fingerprint, Gauge, History, IdCard, ImageUp, MoreHorizontal, Pencil, Plus, Trash2, Truck, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ActiveStatusBadge,
  AutoField,
  EmptyState,
  EntryStatusBadge,
  FieldError,
  FormDialog,
  FormSection,
  InfoField,
  PageHeader,
  PortScopeChip,
  SortHead,
  TablePagination,
  TableShell,
  TableSkeleton,
  TableToolbar,
  usePagedRows,
  useSortedRows,
} from "@/components/shared";
import { SearchSelect, toOptions } from "@/components/ui/search-select";
import { TerminalEnrollDialog } from "@/components/biometric/terminal-enroll-dialog";
import { IdCardDialog, type IdCardImporter } from "@/components/biometric/id-card-dialog";
import { ImporterSummaryPanel } from "@/components/biometric/importer-summary-panel";
import { GroupsManager } from "@/components/importer-groups/groups-manager";
import { BIOMETRIC_STATUS_LABELS, IMPORTER_TYPE_LABELS } from "@/lib/biometric/types";
import { fileToResizedJpeg } from "@/lib/biometric/photo";
import { apiFetch } from "@/lib/client-api";
import { useAppStore, type ContextIntent } from "@/store/app-store";
import { breadcrumbItems } from "@/lib/nav";
import { AFGHAN_PROVINCES } from "@/lib/constants";
import { formatJalali, formatNumber, toPersianDigits } from "@/lib/jalali";
import { newIdempotencyKey } from "@/lib/idempotency";
import { cn } from "@/lib/utils";

// ============================================================
// واردکنندگان — guided registration workflow + standardized list.
//
// The registration/edit dialog walks the officer through explicit
// FormSections (identity → type → type-specific info → contact →
// status review). Border workers must belong to a registered group;
// commercial importers carry no group membership. All payloads,
// queries, mutations and dialogs keep their previous contracts.
// ============================================================

export interface ImporterRow {
  id: number;
  importerCode: string;
  name: string;
  fatherName: string | null;
  tazkiraNumber: string | null;
  province: string | null;
  idCardNumber: string | null;
  biometricStatus: string;
  biometricEnrolledAt: string | null;
  hasPhoto?: boolean;
  companyName: string | null;
  licenseNumber: string | null;
  phone: string | null;
  address: string | null;
  status: "ACTIVE" | "INACTIVE";
  remarks: string | null;
  importerType: string;
  membershipStatus: string;
  registeredCheckpointId: number | null;
  registeredCheckpointName: string | null;
  group: {
    id: number;
    code: string;
    name: string;
    representative: { id: number; name: string; importerCode: string } | null;
  } | null;
  subgroup: { id: number; code: string; name: string } | null;
  /** Official representative of the group (نماینده مسئول گروپ). */
  isGroupRepresentative?: boolean;
  _count: { entries: number; limits: number };
  entries: { importDatetime: string }[];
}

interface ImporterForm {
  importerCode: string;
  name: string;
  fatherName: string;
  tazkiraNumber: string;
  province: string;
  idCardNumber: string;
  photoData: string | null;
  companyName: string;
  licenseNumber: string;
  phone: string;
  address: string;
  status: "ACTIVE" | "INACTIVE";
  remarks: string;
  // Group organization (معلومات گروپ و مسئولیت)
  importerType: "BORDER_WORKER" | "COMMERCIAL";
  groupId: string | null;
  subgroupId: string | null;
  membershipStatus: "ACTIVE" | "INACTIVE";
}

const EMPTY_FORM: ImporterForm = {
  importerCode: "",
  name: "",
  fatherName: "",
  tazkiraNumber: "",
  province: "",
  idCardNumber: "",
  photoData: null,
  companyName: "",
  licenseNumber: "",
  phone: "",
  address: "",
  status: "ACTIVE",
  remarks: "",
  importerType: "COMMERCIAL",
  groupId: null,
  subgroupId: null,
  membershipStatus: "ACTIVE",
};

interface SavedImporter {
  id: number;
  importerCode: string;
  idCardNumber: string | null;
  name: string;
  importerType: string;
}

const TYPE_OPTIONS: Array<"COMMERCIAL" | "BORDER_WORKER"> = ["COMMERCIAL", "BORDER_WORKER"];

const TYPE_DESCRIPTIONS: Record<string, string> = {
  COMMERCIAL: "شرکت یا تاجر با جواز تجارتی — ثبت مستقل بدون گروپ",
  BORDER_WORKER: "کارگر مرزنشین — عضویت در یک گروپ ثبت‌شده الزامی است",
};

/** Labeled form field wrapper: label + control + inline error + hint. */
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
      {error && <FieldError message={error} />}
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Neutral small badge for the importer type column. */
function TypeBadge({ type }: { type: string }) {
  return (
    <span
      className="inline-flex items-center rounded-md border bg-muted px-1.5 py-0.5 text-[10px] leading-4 text-muted-foreground whitespace-nowrap"
      title={IMPORTER_TYPE_LABELS[type] ?? type}
    >
      {IMPORTER_TYPE_LABELS[type] ?? type}
    </span>
  );
}

export default function ImportersView() {
  const user = useAppStore((s) => s.user);
  const queryClient = useQueryClient();
  // Quick-action intent (from the top navbar) — opens the guided dialog.
  const createIntent = useAppStore((s) => s.createIntent);
  const consumeCreateIntent = useAppStore((s) => s.consumeCreateIntent);
  // Global-search hand-off — reactive so it also fires when THIS view is
  // already open (no remount happens then).
  const pendingSearch = useAppStore((s) => s.pendingSearch);
  const consumePendingSearch = useAppStore((s) => s.consumePendingSearch);
  // Cross-view context intents (member hand-off from group detail, etc.)
  const consumeImporterIntent = useAppStore((s) => s.consumeImporterIntent);
  const setEntryIntent = useAppStore((s) => s.setEntryIntent);
  const setLimitIntent = useAppStore((s) => s.setLimitIntent);
  const setView = useAppStore((s) => s.setView);
  const [q, setQ] = React.useState("");
  const [debouncedQ, setDebouncedQ] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("all");
  const [typeFilter, setTypeFilter] = React.useState("all");
  const [groupFilter, setGroupFilter] = React.useState<string | null>(null);
  const [subgroupFilter, setSubgroupFilter] = React.useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ImporterRow | null>(null);
  const [form, setForm] = React.useState<ImporterForm>(EMPTY_FORM);
  const [errors, setErrors] = React.useState<Record<string, string | undefined>>({});
  const [historyId, setHistoryId] = React.useState<number | null>(null);
  // Unsaved-change protection: snapshot of the form when the dialog opened.
  const [savedJson, setSavedJson] = React.useState<string>(JSON.stringify(EMPTY_FORM));
  /** Idempotency key for THIS dialog session (create retries replay). */
  const idemKeyRef = React.useRef<string>(newIdempotencyKey());
  /** Post-save success dialog with next actions. */
  const [savedImporter, setSavedImporter] = React.useState<{
    id: number;
    importerCode: string;
    idCardNumber: string | null;
    name: string;
    importerType: string;
  } | null>(null);

  // ---- biometric dialogs ----
  /** Terminal-physical enrollment (fingerprint / face / palm on the device). */
  const [terminalEnrollId, setTerminalEnrollId] = React.useState<number | null>(null);
  const [cardTarget, setCardTarget] = React.useState<IdCardImporter | null>(null);
  const [summaryId, setSummaryId] = React.useState<number | null>(null);
  const canBiometric = user?.role === "ADMIN" || user?.role === "OFFICER";
  const canEdit = user?.role === "ADMIN" || user?.role === "OFFICER";
  const canCreateEntry = user?.role === "ADMIN" || user?.role === "OFFICER";
  const isAdmin = user?.role === "ADMIN";

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Global-search hand-off: seed the toolbar search AND open the clicked
  // importer's summary panel (focusId). Reacts to every new hand-off.
  React.useEffect(() => {
    if (!pendingSearch || pendingSearch.view !== "importers") return;
    const seeded = consumePendingSearch("importers");
    if (!seeded) return;
    setQ(seeded.q);
    if (typeof seeded.focusId === "number") setSummaryId(seeded.focusId);
  }, [pendingSearch, consumePendingSearch]);

  const clearError = (key: string) =>
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));

  const importers = useQuery({
    placeholderData: keepPreviousData,
    queryKey: ["importers", debouncedQ, statusFilter, typeFilter, groupFilter, subgroupFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (debouncedQ.trim()) params.set("q", debouncedQ.trim());
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (typeFilter !== "all") params.set("type", typeFilter);
      if (groupFilter) params.set("groupId", groupFilter);
      if (subgroupFilter) params.set("subgroupId", subgroupFilter);
      return apiFetch<{ importers: ImporterRow[] }>(`/api/importers?${params.toString()}`);
    },
  });

  // Active groups — used by the registration form AND the table filters.
  const groups = useQuery({
    queryKey: ["importer-groups", "ACTIVE"],
    queryFn: () =>
      apiFetch<{
        groups: Array<{
          id: number;
          code: string;
          name: string;
          status: string;
          representative: { id: number; name: string; importerCode: string } | null;
        }>;
      }>("/api/importer-groups?status=ACTIVE"),
    staleTime: 60_000,
  });

  // Subgroups of the selected group (form — dependent dropdown).
  const formSubgroups = useQuery({
    queryKey: ["importer-group-subgroups", form.groupId],
    queryFn: () =>
      apiFetch<{
        subgroups: Array<{ id: number; code: string; name: string; status: string }>;
      }>(`/api/importer-groups/${form.groupId}/subgroups`),
    enabled: !!form.groupId,
  });

  // Subgroups of the filtered group (table filter — dependent dropdown).
  const filterSubgroups = useQuery({
    queryKey: ["importer-group-subgroups", groupFilter],
    queryFn: () =>
      apiFetch<{
        subgroups: Array<{ id: number; code: string; name: string; status: string }>;
      }>(`/api/importer-groups/${groupFilter}/subgroups`),
    enabled: !!groupFilter,
  });

  const history = useQuery({
    queryKey: ["importer-history", historyId],
    queryFn: () => apiFetch<{ entries: HistoryEntry[] }>(`/api/importers/${historyId}`),
    enabled: historyId !== null,
  });

  const save = useMutation({
    mutationFn: () => {
      // photoData is sent ONLY when a new photo was picked — otherwise the
      // existing photo on the record stays untouched. Importer number and
      // card number are NEVER sent: the server allocates them.
      const base = {
        name: form.name,
        companyName: form.companyName || null,
        fatherName: form.fatherName || null,
        tazkiraNumber: form.tazkiraNumber || null,
        province: form.province || null,
        phone: form.phone,
        address: form.address,
        status: form.status,
        remarks: form.remarks,
        // Group organization — border workers require a group; commercial
        // importers carry no group membership (fields hidden in the form).
        importerType: form.importerType,
        groupId: form.importerType === "BORDER_WORKER" && form.groupId ? Number(form.groupId) : null,
        subgroupId:
          form.importerType === "BORDER_WORKER" && form.groupId && form.subgroupId
            ? Number(form.subgroupId)
            : null,
        membershipStatus:
          form.importerType === "BORDER_WORKER" && form.groupId ? form.membershipStatus : "ACTIVE",
        ...(editing ? {} : { idempotencyKey: idemKeyRef.current }),
      };
      const payload = form.photoData ? { ...base, photoData: form.photoData } : base;
      if (editing) {
        return apiFetch<{ importer: SavedImporter }>(`/api/importers/${editing.id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
      }
      return apiFetch<{ importer: SavedImporter; idempotentReplay?: boolean }>("/api/importers", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },
    onSuccess: (data) => {
      const importer = (data as { importer?: SavedImporter }).importer;
      queryClient.invalidateQueries({ queryKey: ["importers"] });
      queryClient.invalidateQueries({ queryKey: ["importer-groups"] });
      queryClient.invalidateQueries({ queryKey: ["importer-group"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      setDialogOpen(false);
      if (editing) {
        toast.success("اطلاعات واردکننده ویرایش شد.");
      } else if (importer) {
        // SUCCESS PANEL — generated identifiers + authorized next actions.
        setSavedImporter(importer);
        toast.success("واردکننده جدید ثبت شد.");
      }
    },
    onError: (e: Error) => {
      // Failed saves keep every entered value (dialog stays open).
      toast.error(e.message);
    },
  });

  const openCreate = (preset?: ContextIntent) => {
    setEditing(null);
    // Fresh identity context: server allocates importer + card numbers.
    idemKeyRef.current = newIdempotencyKey();
    const nextForm: ImporterForm = {
      ...EMPTY_FORM,
      // "Add member" hand-off from group detail: group + subgroup arrive
      // pre-selected so the user never searches for them again.
      importerType: preset?.groupId ? "BORDER_WORKER" : EMPTY_FORM.importerType,
      groupId: preset?.groupId ? String(preset.groupId) : null,
      subgroupId: preset?.subgroupId ? String(preset.subgroupId) : null,
    };
    setForm(nextForm);
    setSavedJson(JSON.stringify(nextForm));
    setErrors({});
    setDialogOpen(true);
  };

  // Quick action "ثبت واردکننده" + cross-view context hand-off.
  React.useEffect(() => {
    if (createIntent === "importer" && canBiometric) {
      if (consumeCreateIntent("importer")) openCreate();
    }
  }, [createIntent, canBiometric]);
  React.useEffect(() => {
    const intent = consumeImporterIntent();
    if (intent && canBiometric) openCreate(intent);
     
  }, []);

  const openEdit = (row: ImporterRow) => {
    const nextForm: ImporterForm = {
      importerCode: row.importerCode,
      name: row.name,
      fatherName: row.fatherName ?? "",
      tazkiraNumber: row.tazkiraNumber ?? "",
      province: row.province ?? "",
      idCardNumber: row.idCardNumber ?? "",
      photoData: null, // served separately via /photo — null keeps existing photo
      companyName: row.companyName ?? "",
      licenseNumber: row.licenseNumber ?? "",
      phone: row.phone ?? "",
      address: row.address ?? "",
      status: row.status,
      remarks: row.remarks ?? "",
      importerType: row.importerType === "BORDER_WORKER" ? "BORDER_WORKER" : "COMMERCIAL",
      groupId: row.group ? String(row.group.id) : null,
      subgroupId: row.subgroup ? String(row.subgroup.id) : null,
      membershipStatus: row.membershipStatus === "INACTIVE" ? "INACTIVE" : "ACTIVE",
    };
    setEditing(row);
    setForm(nextForm);
    setSavedJson(JSON.stringify(nextForm));
    setErrors({});
    setDialogOpen(true);
  };

  const submit = () => {
    const next: Record<string, string | undefined> = {};
    // Importer number and card number are SYSTEM-GENERATED — they are never
    // required from the user and never produce a required-field error.
    if (form.name.trim().length < 2) next.name = "لطفاً نام واردکننده را بنویسید.";
    if (form.importerType === "BORDER_WORKER" && !form.groupId)
      next.group = "برای کارگر مرزنشین، انتخاب گروپ ضروری است.";
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    save.mutate();
  };

  const onPickPhoto = async (file: File | undefined) => {
    if (!file) return;
    try {
      const b64 = await fileToResizedJpeg(file);
      setForm((f) => ({ ...f, photoData: b64 }));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const allRows = importers.data?.importers ?? [];
  const { sorted, sort, toggleSort } = useSortedRows<ImporterRow>(
    allRows,
    React.useMemo(
      () => ({
        code: (r) => r.importerCode,
        name: (r) => r.name,
        type: (r) => IMPORTER_TYPE_LABELS[r.importerType] ?? r.importerType,
        status: (r) => r.status,
      }),
      []
    )
  );
  const paging = usePagedRows(sorted, 15);

  const terminalEnrollImporter = allRows.find((r) => r.id === terminalEnrollId) ?? null;
  const historyImporter = allRows.find((r) => r.id === historyId) ?? null;

  // Unsaved-change protection for the guided dialog.
  const dirty = dialogOpen && JSON.stringify(form) !== savedJson;

  const openCardFor = (row: ImporterRow) => {
    setCardTarget({
      id: row.id,
      importerCode: row.importerCode,
      name: row.name,
      fatherName: row.fatherName,
      idCardNumber: row.idCardNumber,
      companyName: row.companyName,
      status: row.status,
      biometricStatus: row.biometricStatus,
      biometricEnrolledAt: row.biometricEnrolledAt,
      hasPhoto: row.hasPhoto ?? false,
      importerType: row.importerType,
      groupName: row.group?.name ?? null,
      subgroupName: row.subgroup?.name ?? null,
      representativeName: row.group?.representative?.name ?? null,
    });
  };

  return (
    <div>
      <PageHeader
        breadcrumbs={breadcrumbItems("importers")}
        title="مدیریت واردکنندگان"
        description="ثبت هدایت‌شده واردکنندگان، گروپ‌بندی، بایومتریک و پیگیری واردات"
        actions={
          <>
            {!isAdmin && <PortScopeChip isNationwide={false} checkpointName={user?.checkpointName} />}
            {canEdit && (
              <Button onClick={() => openCreate()}>
                <Plus className="size-4" />
                ثبت واردکننده جدید
              </Button>
            )}
          </>
        }
      />

      <Tabs defaultValue="list" className="w-full">
        <TabsList className="mb-3">
          <TabsTrigger value="list" className="gap-1.5">
            <Truck className="size-4" />
            لیست واردکنندگان
          </TabsTrigger>
          {isAdmin && (
            <TabsTrigger value="groups" className="gap-1.5">
              <Users className="size-4" />
              گروپ‌ها
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="list" className="mt-0">
          <TableShell
            toolbar={
              <TableToolbar
                value={q}
                onChange={setQ}
                placeholder="جستجو بر اساس نام، شرکت، نمبر، تذکره یا جواز..."
              >
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="sm:w-40 h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">همه وضعیت‌ها</SelectItem>
                    <SelectItem value="ACTIVE">فعال</SelectItem>
                    <SelectItem value="INACTIVE">غیرفعال</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v)}>
                  <SelectTrigger className="sm:w-44 h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">همه انواع</SelectItem>
                    <SelectItem value="BORDER_WORKER">کارگر مرزنشین</SelectItem>
                    <SelectItem value="COMMERCIAL">واردکننده تجارتی</SelectItem>
                  </SelectContent>
                </Select>
                <SearchSelect
                  value={groupFilter}
                  onChange={(v) => {
                    setGroupFilter(v);
                    setSubgroupFilter(null);
                  }}
                  options={toOptions(
                    groups.data?.groups,
                    (g) => String(g.id),
                    (g) => g.name,
                    (g) => g.code
                  )}
                  placeholder="همه گروپ‌ها"
                  searchPlaceholder="جستجوی گروپ…"
                  loading={groups.isLoading}
                  allowClear
                  className="sm:w-44 h-9"
                  aria-label="فیلتر گروپ"
                />
                <SearchSelect
                  value={subgroupFilter}
                  onChange={(v) => setSubgroupFilter(v)}
                  options={toOptions(
                    filterSubgroups.data?.subgroups,
                    (s) => String(s.id),
                    (s) => s.name,
                    (s) => s.code
                  )}
                  placeholder={groupFilter ? "همه زیرگروپ‌ها" : "ابتدا گروپ را انتخاب کنید"}
                  searchPlaceholder="جستجوی زیرگروپ…"
                  loading={filterSubgroups.isLoading}
                  disabled={!groupFilter}
                  allowClear
                  className="sm:w-44 h-9"
                  aria-label="فیلتر زیرگروپ"
                />
              </TableToolbar>
            }
            footer={
              <TablePagination
                page={paging.page}
                pageCount={paging.pageCount}
                total={paging.total}
                onPage={paging.setPage}
                entityLabel="واردکننده"
              />
            }
            maxHeight="65vh"
          >
            {importers.isLoading ? (
              <TableSkeleton rows={6} cols={6} />
            ) : !importers.data?.importers.length ? (
              <EmptyState
                icon={<Truck className="size-10" />}
                title="هیچ واردکننده‌ای یافت نشد"
                description="واردکننده جدید ثبت کنید یا شرایط جستجو و فیلترها را تغییر دهید."
                action={
                  canEdit ? (
                    <Button onClick={() => openCreate()}>
                      <Plus className="size-4" />
                      ثبت واردکننده جدید
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <div className="min-w-[720px]">
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-muted">
                    <TableRow>
                      <SortHead label="نمبر" k="code" sort={sort} onSort={toggleSort} />
                      <SortHead label="نام واردکننده" k="name" sort={sort} onSort={toggleSort} />
                      <SortHead label="نوع" k="type" sort={sort} onSort={toggleSort} className="hidden md:table-cell" />
                      <TableHead className="hidden md:table-cell">گروپ / زیرگروپ</TableHead>
                      <TableHead className="hidden md:table-cell">شماره تماس</TableHead>
                      {isAdmin && <TableHead className="hidden sm:table-cell">بندر ثبت</TableHead>}
                      <TableHead className="text-center hidden md:table-cell">بایومتریک</TableHead>
                      <SortHead label="وضعیت" k="status" sort={sort} onSort={toggleSort} className="hidden md:table-cell" />
                      <TableHead className="no-print">عملیات</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paging.paged.map((row) => (
                      <TableRow key={row.id} className="hover:bg-muted/40">
                        {/* Identity — always visible */}
                        <TableCell className="font-mono text-xs whitespace-nowrap">{row.importerCode}</TableCell>
                        <TableCell>
                          <div className="min-w-0">
                            <span className="flex items-center gap-1.5 min-w-0">
                              <span className="font-medium max-w-40 truncate" title={row.name}>
                                {row.name}
                              </span>
                              {row.isGroupRepresentative && (
                                <span
                                  className="inline-flex shrink-0 items-center gap-1 rounded-full border border-gold/60 bg-gold/10 px-1.5 py-px text-[10px] font-medium text-primary"
                                  title="نماینده مسئول گروپ — این واردکننده نماینده رسمی گروپ خویش است"
                                >
                                  <IdCard className="size-3" aria-hidden />
                                  نماینده گروپ
                                </span>
                              )}
                            </span>
                            {row.fatherName && (
                              <span className="block text-xs text-muted-foreground max-w-44 truncate" title={row.fatherName}>
                                {row.fatherName}
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <TypeBadge type={row.importerType} />
                        </TableCell>
                        <TableCell className="text-xs hidden md:table-cell">
                          {row.group ? (
                            <span
                              className={cn(
                                "inline-flex items-center gap-1 max-w-40 truncate",
                                row.membershipStatus === "INACTIVE" && "text-muted-foreground line-through"
                              )}
                              title={
                                `گروپ: ${row.group.name}${row.subgroup ? ` — زیرگروپ: ${row.subgroup.name}` : ""}${
                                  row.group.representative ? ` — نماینده: ${row.group.representative.name}` : ""
                                }`
                              }
                            >
                              <Users className="size-3 shrink-0 text-muted-foreground" />
                              {row.group.name}
                              {row.subgroup && <span className="text-muted-foreground"> / {row.subgroup.name}</span>}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell dir="ltr" className="text-xs text-right font-mono hidden md:table-cell">
                          {row.phone ?? "—"}
                        </TableCell>
                        {isAdmin && (
                          <TableCell className="text-xs text-muted-foreground hidden sm:table-cell">
                            <span
                              className="block max-w-28 truncate"
                              title={row.registeredCheckpointName ?? "ثبت مرکزی — قابل مشاهده در همه بنادر"}
                            >
                              {row.registeredCheckpointName ?? "مرکزی"}
                            </span>
                          </TableCell>
                        )}
                        <TableCell className="text-center hidden md:table-cell">
                          <span
                            className={cn(
                              "inline-block size-2 rounded-full",
                              row.biometricStatus === "ENROLLED" ? "bg-success" : "bg-muted-foreground/40"
                            )}
                            title={
                              row.biometricStatus === "ENROLLED"
                                ? `${BIOMETRIC_STATUS_LABELS[row.biometricStatus] ?? row.biometricStatus} — هویت روی ترمینال مرزی تأیید شده`
                                : "ثبت بایومتریک روی ترمینال انجام نشده است"
                            }
                          />
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <ActiveStatusBadge status={row.status} />
                        </TableCell>
                        <TableCell className="no-print">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" title="عملیات" className="size-8">
                                <MoreHorizontal className="size-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start" className="w-56">
                              <DropdownMenuItem onClick={() => setSummaryId(row.id)}>
                                <Eye className="size-4" />
                                معلومات و سوابق واردکننده
                              </DropdownMenuItem>
                              {row.status === "ACTIVE" && (canCreateEntry) && (
                                <DropdownMenuItem
                                  onClick={() => {
                                    setEntryIntent({ importerId: row.id });
                                    setView("entries");
                                  }}
                                  className="text-primary"
                                >
                                  <FilePlus2 className="size-4" />
                                  ثبت واردات جدید برای این واردکننده
                                </DropdownMenuItem>
                              )}
                              {isAdmin && row.status === "ACTIVE" && (
                                <DropdownMenuItem
                                  onClick={() => {
                                    setLimitIntent({ importerId: row.id });
                                    setView("limits");
                                  }}
                                >
                                  <Gauge className="size-4" />
                                  تعیین حد مجاز برای این واردکننده
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem onClick={() => setHistoryId(row.id)}>
                                <History className="size-4" />
                                مشاهده سابقه واردات
                              </DropdownMenuItem>
                              {canBiometric && (
                                <DropdownMenuItem onClick={() => setTerminalEnrollId(row.id)} className="text-primary">
                                  <Fingerprint className="size-4" />
                                  ثبت اثر انگشت، چهره یا کف دست
                                </DropdownMenuItem>
                              )}
                              {canBiometric && (
                                <DropdownMenuItem onClick={() => openCardFor(row)}>
                                  <IdCard className="size-4" />
                                  چاپ کارت شناسایی
                                </DropdownMenuItem>
                              )}
                              {canEdit && (
                                <>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem onClick={() => openEdit(row)}>
                                    <Pencil className="size-4" />
                                    ویرایش
                                  </DropdownMenuItem>
                                </>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TableShell>
        </TabsContent>

        {isAdmin && (
          <TabsContent value="groups" className="mt-0">
            <GroupsManager />
          </TabsContent>
        )}
      </Tabs>

      {/* ---------- Guided registration / edit dialog ---------- */}
      <FormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={editing ? "ویرایش واردکننده" : "ثبت واردکننده جدید"}
        description={
          editing
            ? "معلومات واردکننده را در بخش‌های مربوط ویرایش کنید."
            : "معلومات واردکننده را گام‌به‌گام در بخش‌های مربوط درج نمایید."
        }
        icon={<Truck className="size-5 text-primary shrink-0" />}
        size="lg"
        busy={save.isPending}
        dirty={dirty}
        onSubmit={submit}
        submitLabel={editing ? "ذخیره تغییرات" : "ثبت واردکننده"}
      >
        {/* Read-only identity strip (edit mode) */}
        {editing && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3 rounded-xl border bg-muted/20 p-3">
            <InfoField
              label="نمبر واردکننده"
              value={<span className="font-mono text-xs" dir="ltr">{editing.importerCode}</span>}
            />
            <InfoField
              label="وضعیت بایومتریک"
              value={BIOMETRIC_STATUS_LABELS[editing.biometricStatus] ?? editing.biometricStatus}
            />
            {isAdmin && (
              <InfoField label="بندر ثبت" value={editing.registeredCheckpointName ?? "ثبت مرکزی"} />
            )}
          </div>
        )}

        {/* 1 — هویت واردکننده */}
        <FormSection title="هویت واردکننده">
          <FieldBlock label="نام واردکننده" htmlFor="imp-name" required error={errors.name}>
            <Input
              id="imp-name"
              value={form.name}
              onChange={(e) => {
                setForm({ ...form, name: e.target.value });
                clearError("name");
              }}
              placeholder="نام کامل"
              aria-invalid={!!errors.name}
            />
          </FieldBlock>
          <FieldBlock label="نام پدر" htmlFor="imp-father">
            <Input
              id="imp-father"
              value={form.fatherName}
              onChange={(e) => setForm({ ...form, fatherName: e.target.value })}
              placeholder="نام پدر"
            />
          </FieldBlock>
          <FieldBlock label="نمبر تذکره" htmlFor="imp-tazkira" hint="اعداد فارسی/عربی/انگلیسی هر سه پذیرفته می‌شود.">
            <Input
              id="imp-tazkira"
              dir="ltr"
              className="text-left"
              value={form.tazkiraNumber}
              onChange={(e) => setForm({ ...form, tazkiraNumber: e.target.value })}
              placeholder="۱۴۰۱-۰۰۱۲-۳۴۵۶۷"
            />
          </FieldBlock>
          <FieldBlock label="ولایت اقامت" htmlFor="imp-province">
            <SearchSelect
              id="imp-province"
              value={form.province || null}
              onChange={(v) => setForm((f) => ({ ...f, province: v ?? "" }))}
              options={[
                // Keep legacy province spellings selectable when editing old records.
                ...(form.province && !AFGHAN_PROVINCES.includes(form.province)
                  ? [{ value: form.province, label: form.province }]
                  : []),
                ...AFGHAN_PROVINCES.map((p) => ({ value: p, label: p })),
              ]}
              placeholder="انتخاب ولایت"
              searchPlaceholder="جستجوی ولایت…"
              allowClear
            />
          </FieldBlock>
          {/* Photograph (part of identity) */}
          <FieldBlock label="عکس واردکننده" span>
            <div className="flex items-center gap-3">
              <PhotoBox importerId={editing?.id ?? null} newPhoto={form.photoData} />
              <div className="space-y-2">
                <label className="inline-flex">
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={(e) => onPickPhoto(e.target.files?.[0])}
                    aria-label="انتخاب عکس واردکننده"
                  />
                  <span className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 h-9 text-sm cursor-pointer hover:bg-muted/60 transition-colors">
                    <ImageUp className="size-4" />
                    انتخاب عکس
                  </span>
                </label>
                {form.photoData && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive h-8 gap-1"
                    onClick={() => setForm((f) => ({ ...f, photoData: null }))}
                  >
                    <Trash2 className="size-3.5" />
                    حذف عکس جدید
                  </Button>
                )}
                <p className="text-[10px] text-muted-foreground">
                  عکس به صورت خودکار کوچک و با کیفیت JPEG ذخیره می‌شود.
                </p>
              </div>
            </div>
          </FieldBlock>
        </FormSection>

        {/* 2 — نوع واردکننده (radio cards) */}
        <FormSection title="نوع واردکننده">
          <div className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-2" role="radiogroup" aria-label="نوع واردکننده">
            {TYPE_OPTIONS.map((t) => {
              const active = form.importerType === t;
              return (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => {
                    const importerType = t;
                    setForm((f) => ({
                      ...f,
                      importerType,
                      // switching to commercial clears border-worker-only fields
                      groupId: importerType === "BORDER_WORKER" ? f.groupId : null,
                      subgroupId: importerType === "BORDER_WORKER" ? f.subgroupId : null,
                    }));
                    clearError("group");
                  }}
                  className={cn(
                    "rounded-xl border p-3 text-start space-y-1 transition-colors",
                    active ? "border-primary bg-muted/50" : "border-border bg-card hover:bg-muted/40"
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "size-3.5 rounded-full border grid place-items-center shrink-0",
                        active ? "border-primary" : "border-muted-foreground/50"
                      )}
                    >
                      {active && <span className="size-1.5 rounded-full bg-primary" />}
                    </span>
                    <span className={cn("text-sm font-medium", active ? "text-foreground" : "text-muted-foreground")}>
                      {IMPORTER_TYPE_LABELS[t]}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">{TYPE_DESCRIPTIONS[t]}</p>
                </button>
              );
            })}
          </div>
        </FormSection>

        {/* 3 — کارگر مرزی (conditional) */}
        {form.importerType === "BORDER_WORKER" && (
          <FormSection title="معلومات کارگر مرزی">
            <div className="sm:col-span-2 rounded-lg border bg-muted/30 p-2.5 text-xs text-muted-foreground">
              کارگر مرزی باید عضو یک گروپ فعال باشد؛ نماینده با انتخاب گروپ خودکار نمایش داده می‌شود.
            </div>
            <FieldBlock label="گروپ" required error={errors.group} hint="فقط گروپ‌های فعال قابل انتخاب هستند.">
              <SearchSelect
                value={form.groupId}
                onChange={(v) => {
                  setForm((f) => ({ ...f, groupId: v, subgroupId: null }));
                  clearError("group");
                }}
                options={toOptions(
                  groups.data?.groups,
                  (g) => String(g.id),
                  (g) => g.name,
                  (g) => g.code
                )}
                placeholder="انتخاب گروپ فعال…"
                searchPlaceholder="جستجوی گروپ…"
                loading={groups.isLoading}
                allowClear
                invalid={!!errors.group}
                aria-label="انتخاب گروپ"
              />
            </FieldBlock>
            {form.groupId && (
              <FieldBlock label="زیرگروپ (اختیاری)" hint="فقط زیرگروپ‌های گروپ انتخاب‌شده نشان داده می‌شود.">
                <SearchSelect
                  value={form.subgroupId}
                  onChange={(v) => setForm((f) => ({ ...f, subgroupId: v }))}
                  options={toOptions(
                    formSubgroups.data?.subgroups.filter((s) => s.status === "ACTIVE"),
                    (s) => String(s.id),
                    (s) => s.name,
                    (s) => s.code
                  )}
                  placeholder="انتخاب زیرگروپ…"
                  searchPlaceholder="جستجوی زیرگروپ…"
                  loading={formSubgroups.isLoading}
                  allowClear
                  aria-label="انتخاب زیرگروپ"
                />
              </FieldBlock>
            )}
            {form.groupId && (
              <FieldBlock label="نماینده مسئول گروپ" hint="به صورت خودکار از گروپ انتخاب‌شده تکمیل می‌شود.">
                <div className="h-9 flex items-center gap-2 rounded-md border bg-muted/40 px-3 text-sm">
                  {(() => {
                    const rep = groups.data?.groups.find((g) => String(g.id) === form.groupId)?.representative;
                    return rep ? (
                      <>
                        <span className="font-medium truncate">{rep.name}</span>
                        <span className="text-[11px] text-muted-foreground font-mono" dir="ltr">{rep.importerCode}</span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">برای این گروپ نماینده‌ای تعیین نشده است</span>
                    );
                  })()}
                </div>
              </FieldBlock>
            )}
            {form.groupId && (
              <FieldBlock label="وضعیت عضویت" htmlFor="imp-membership" hint="وضعیت عضویت کارگر در گروپ انتخاب‌شده.">
                <Select
                  value={form.membershipStatus}
                  onValueChange={(v) => setForm((f) => ({ ...f, membershipStatus: v as "ACTIVE" | "INACTIVE" }))}
                >
                  <SelectTrigger id="imp-membership">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ACTIVE">فعال</SelectItem>
                    <SelectItem value="INACTIVE">غیرفعال</SelectItem>
                  </SelectContent>
                </Select>
              </FieldBlock>
            )}
          </FormSection>
        )}

        {/* 5 — معلومات تماس */}
        <FormSection title="معلومات تماس">
          <FieldBlock label="شماره تماس" htmlFor="imp-phone">
            <Input
              id="imp-phone"
              type="tel"
              dir="ltr"
              className="text-left"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              placeholder="07xxxxxxxxx"
            />
          </FieldBlock>
          <FieldBlock label="آدرس" htmlFor="imp-address">
            <Input
              id="imp-address"
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
            />
          </FieldBlock>
        </FormSection>

        {/* 6 — بررسی اسناد و وضعیت */}
        <FormSection title="وضعیت">
          <FieldBlock label="وضعیت" htmlFor="imp-status" hint="غیرفعال یعنی واردکننده موقتاً امکان ثبت واردات ندارد.">
            <Select
              value={form.status}
              onValueChange={(v) => setForm({ ...form, status: v as "ACTIVE" | "INACTIVE" })}
            >
              <SelectTrigger id="imp-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ACTIVE">فعال</SelectItem>
                <SelectItem value="INACTIVE">غیرفعال</SelectItem>
              </SelectContent>
            </Select>
          </FieldBlock>
          <FieldBlock label="ملاحظات" htmlFor="imp-remarks">
            <Textarea
              id="imp-remarks"
              rows={2}
              value={form.remarks}
              onChange={(e) => setForm({ ...form, remarks: e.target.value })}
            />
          </FieldBlock>
        </FormSection>

        {/* Terminal-physical enrollment — confirm an identity enrolled
            ON the border terminal (fingerprint / face / palm). */}
        {editing && canBiometric && (
          <div className="sm:col-span-2 flex flex-wrap justify-start pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-9 gap-1.5"
              onClick={() => setTerminalEnrollId(editing.id)}
            >
              <Fingerprint className="size-4 text-primary" aria-hidden />
              ثبت اثر انگشت، چهره یا کف دست
            </Button>
            <span className="text-[11px] text-muted-foreground self-center me-2 leading-4">
              تأیید هویتِ ثبت‌شده روی ترمینال فیزیکی بندر
            </span>
          </div>
        )}
      </FormDialog>

      {/* ---------- Post-save success: identifiers + authorized next actions ---------- */}
      {savedImporter && (
        <Dialog open onOpenChange={(v) => !v && setSavedImporter(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-success">
                <CheckCircle2 className="size-5" aria-hidden />
                واردکننده ثبت شد
              </DialogTitle>
              <DialogDescription>
                نمبر واردکننده و شماره کارت شناسایی به‌صورت خودکار توسط سیستم تولید شد.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <AutoField label="نمبر واردکننده" value={savedImporter.importerCode} />
              <AutoField label="شماره کارت شناسایی" value={savedImporter.idCardNumber} />
              <div className="text-xs text-muted-foreground">
                نام: <span className="font-medium text-foreground">{savedImporter.name}</span> —{" "}
                {IMPORTER_TYPE_LABELS[savedImporter.importerType] ?? savedImporter.importerType}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => {
                  const id = savedImporter.id;
                  setSavedImporter(null);
                  setSummaryId(id);
                }}
              >
                <Eye className="size-4" aria-hidden />
                مشاهده پروفایل
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setSavedImporter(null);
                  openCreate();
                }}
              >
                <Plus className="size-4" aria-hidden />
                ثبت واردکننده دیگر
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  const id = savedImporter.id;
                  setSavedImporter(null);
                  setTerminalEnrollId(id);
                }}
              >
                <Fingerprint className="size-4" aria-hidden />
                ثبت اثر انگشت، چهره یا کف دست
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Terminal-physical enrollment dialog */}
      {terminalEnrollImporter && (
        <TerminalEnrollDialog
          open={terminalEnrollId !== null}
          onOpenChange={(v) => !v && setTerminalEnrollId(null)}
          importer={{
            id: terminalEnrollImporter.id,
            name: terminalEnrollImporter.name,
            importerCode: terminalEnrollImporter.importerCode,
          }}
        />
      )}

      {/* ID card dialog */}
      <IdCardDialog open={cardTarget !== null} onOpenChange={(v) => !v && setCardTarget(null)} importer={cardTarget} />

      {/* Importer summary (profile + quota + history) — "New import"
          carries the selected importer into the entry form. */}
      <ImporterSummaryPanel
        importerId={summaryId}
        open={summaryId !== null}
        onOpenChange={(v) => !v && setSummaryId(null)}
        onNewEntry={(importerId) => {
          setSummaryId(null);
          setEntryIntent({ importerId });
          setView("entries");
        }}
      />

      {/* History dialog */}
      <Dialog open={historyId !== null} onOpenChange={(v) => !v && setHistoryId(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>تاریخچه واردات واردکننده</DialogTitle>
            <DialogDescription>
              {history.data?.entries?.length
                ? `${toPersianDigits(history.data.entries.length)} ثبت واردات`
                : "بارگذاری..."}
            </DialogDescription>
          </DialogHeader>
          {historyImporter && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3 rounded-xl border bg-muted/20 p-3">
              <InfoField
                label="نمبر واردکننده"
                value={<span className="font-mono text-xs" dir="ltr">{historyImporter.importerCode}</span>}
              />
              <InfoField label="نام واردکننده" value={historyImporter.name} />
              <InfoField label="نوع" value={IMPORTER_TYPE_LABELS[historyImporter.importerType] ?? historyImporter.importerType} />
              <InfoField
                label="گروپ / زیرگروپ"
                value={
                  historyImporter.group
                    ? `${historyImporter.group.name}${historyImporter.subgroup ? ` / ${historyImporter.subgroup.name}` : ""}`
                    : "—"
                }
              />
              <InfoField
                label="شماره تماس"
                value={<span className="font-mono text-xs" dir="ltr">{historyImporter.phone ?? "—"}</span>}
              />
              <InfoField label="وضعیت" value={<ActiveStatusBadge status={historyImporter.status} />} />
            </div>
          )}
          {history.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-8 rounded bg-muted animate-pulse" />
              ))}
            </div>
          ) : !history.data?.entries.length ? (
            <EmptyState icon={<History className="size-8" />} title="تاریخچه‌ای موجود نیست" />
          ) : (
            <div className="rounded-md border overflow-hidden">
              <div className="overflow-x-auto max-h-[50vh] overflow-y-auto">
                <Table>
                  <TableHeader className="sticky top-0 bg-muted z-10">
                    <TableRow>
                      <TableHead>نمبر ثبت</TableHead>
                      <TableHead>تاریخ واردات</TableHead>
                      <TableHead>بندر</TableHead>
                      <TableHead>اجناس</TableHead>
                      <TableHead>وضعیت</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {history.data.entries.map((e) => {
                      const itemsText = e.items
                        .map((i) => `${i.item.itemName} (${formatNumber(i.quantity)} ${i.uom.symbol})`)
                        .join("، ");
                      return (
                        <TableRow key={e.id}>
                          <TableCell className="font-mono text-xs">{e.entryNumber}</TableCell>
                          <TableCell className="text-xs">{formatJalali(e.importDatetime)}</TableCell>
                          <TableCell>{e.checkpoint.name}</TableCell>
                          <TableCell className="text-xs max-w-64 truncate" title={itemsText}>
                            {itemsText}
                          </TableCell>
                          <TableCell>
                            <EntryStatusBadge status={e.status} />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PhotoBox({ importerId, newPhoto }: { importerId: number | null; newPhoto: string | null }) {
  const [ver, setVer] = React.useState(0);
  const [imgFailed, setImgFailed] = React.useState(false);
  React.useEffect(() => setVer((v) => v + 1), [newPhoto]);
  const src = newPhoto
    ? `data:image/jpeg;base64,${newPhoto}`
    : importerId
      ? `/api/importers/${importerId}/photo?v=${ver}`
      : null;
  // A 404 (no photo stored) must show the placeholder text, not an empty box.
  React.useEffect(() => setImgFailed(false), [src]);
  const showImg = src && !imgFailed;
  return (
    <div className={cn(
      "size-20 shrink-0 rounded-lg border overflow-hidden bg-muted/30 grid place-items-center",
      !showImg && "border-dashed"
    )}>
      {showImg ? (
        <img
          src={src}
          alt="عکس واردکننده"
          className="w-full h-full object-cover"
          onError={() => setImgFailed(true)}
        />
      ) : (
        <span className="text-[10px] text-muted-foreground">بدون عکس</span>
      )}
    </div>
  );
}

interface HistoryEntry {
  id: number;
  entryNumber: string;
  importDatetime: string;
  status: string;
  checkpoint: { name: string };
  items: { item: { itemName: string }; uom: { symbol: string }; quantity: number }[];
  creator: { name: string } | null;
}
export { ImportersView };
