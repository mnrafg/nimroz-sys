"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeftRight,
  Calculator,
  Info,
  Pencil,
  Plus,
  Power,
  Ruler,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SearchSelect, toOptions } from "@/components/ui/search-select";
import { apiFetch } from "@/lib/client-api";
import { formatNumber, toPersianDigits } from "@/lib/jalali";
import { STATUS_LABELS } from "@/lib/constants";
import { breadcrumbItems } from "@/lib/nav";
import { searchMatch } from "@/lib/utils";
import {
  ActiveStatusBadge,
  ConfirmDialog,
  EmptyState,
  FieldError,
  FormDialog,
  FormSection,
  PageHeader,
  SortHead,
  TablePagination,
  TableShell,
  TableSkeleton,
  TableToolbar,
  usePagedRows,
  useSortedRows,
} from "@/components/shared";
import { useAppStore } from "@/store/app-store";
import { cn } from "@/lib/utils";

// ============================================================
// واحدات اندازه‌گیری + تبدیلات — two-tab management view
// ============================================================

interface UomRow {
  id: number;
  code: string;
  name: string;
  symbol: string;
  status: string;
  _count: { items: number };
}

interface ItemLite {
  id: number;
  itemCode: string;
  itemName: string;
  status: string;
}

interface ConversionRow {
  id: number;
  itemId: number;
  fromUomId: number;
  toUomId: number;
  conversionFactor: number;
  item: { itemName: string; itemCode: string };
  fromUom: { name: string; symbol: string };
  toUom: { name: string; symbol: string };
}

/** Labeled field wrapper: label + required mark + control + error + hint. */
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
      <label className="text-sm font-medium leading-none" htmlFor={htmlFor}>
        {label}
        {required && <span className="text-danger"> *</span>}
      </label>
      {children}
      {error && <FieldError message={error} />}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

interface UomFormState {
  code: string;
  name: string;
  symbol: string;
  status: string;
}

const EMPTY_UOM_FORM: UomFormState = {
  code: "",
  name: "",
  symbol: "",
  status: "ACTIVE",
};

interface ConvFormState {
  itemId: string;
  fromUomId: string;
  toUomId: string;
  conversionFactor: string;
}

const EMPTY_CONV_FORM: ConvFormState = {
  itemId: "",
  fromUomId: "",
  toUomId: "",
  conversionFactor: "",
};

function UomsView() {
  const user = useAppStore((s) => s.user);
  const isAdmin = user?.role === "ADMIN";
  const queryClient = useQueryClient();

  const uomsQ = useQuery({
    queryKey: ["uoms"],
    queryFn: () => apiFetch<{ uoms: UomRow[] }>("/api/uoms"),
  });

  const activeItemsQ = useQuery({
    queryKey: ["items", "active-lite"],
    queryFn: () => apiFetch<{ items: ItemLite[] }>("/api/items?status=ACTIVE"),
  });

  const uoms = uomsQ.data?.uoms ?? [];
  const activeItems = activeItemsQ.data?.items ?? [];
  const activeUoms = uoms.filter((u) => u.status === "ACTIVE");

  // ============================================================
  // Tab 1: units
  // ============================================================

  const [uomDialogOpen, setUomDialogOpen] = React.useState(false);
  const [editingUom, setEditingUom] = React.useState<UomRow | null>(null);
  const [uomForm, setUomForm] = React.useState<UomFormState>(EMPTY_UOM_FORM);
  const [savedUomJson, setSavedUomJson] = React.useState(JSON.stringify(EMPTY_UOM_FORM));
  const [uomErrors, setUomErrors] = React.useState<Record<string, string | undefined>>({});
  const [statusUom, setStatusUom] = React.useState<UomRow | null>(null);

  const uomDirty = uomDialogOpen && JSON.stringify(uomForm) !== savedUomJson;

  const clearUomError = (key: string) =>
    setUomErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));

  const openUomCreate = () => {
    setEditingUom(null);
    setUomForm(EMPTY_UOM_FORM);
    setSavedUomJson(JSON.stringify(EMPTY_UOM_FORM));
    setUomErrors({});
    setUomDialogOpen(true);
  };

  const openUomEdit = (row: UomRow) => {
    setEditingUom(row);
    const next: UomFormState = {
      code: row.code,
      name: row.name,
      symbol: row.symbol,
      status: row.status,
    };
    setUomForm(next);
    setSavedUomJson(JSON.stringify(next));
    setUomErrors({});
    setUomDialogOpen(true);
  };

  const saveUom = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      editingUom
        ? apiFetch<{ uom: UomRow }>(`/api/uoms/${editingUom.id}`, {
            method: "PUT",
            body: JSON.stringify(body),
          })
        : apiFetch<{ uom: UomRow }>("/api/uoms", {
            method: "POST",
            body: JSON.stringify(body),
          }),
    onSuccess: () => {
      toast.success(
        editingUom ? "معلومات واحد با موفقیت به‌روزرسانی شد." : "واحد جدید با موفقیت ثبت شد."
      );
      queryClient.invalidateQueries({ queryKey: ["uoms"] });
      setUomDialogOpen(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const submitUom = () => {
    const next: Record<string, string | undefined> = {};
    // Standard/official code (LTR, KGM, TON …) is OPTIONAL — when blank the
    // server generates an internal code (UOM-nn). Never invented from names.
    if (!uomForm.name.trim()) next.name = "لطفاً نام واحد را بنویسید.";
    if (!uomForm.symbol.trim()) next.symbol = "لطفاً علامت واحد را بنویسید.";
    setUomErrors(next);
    if (Object.values(next).some(Boolean)) return;
    saveUom.mutate({
      code: uomForm.code.trim().toUpperCase() || null,
      name: uomForm.name.trim(),
      symbol: uomForm.symbol.trim(),
      status: uomForm.status,
    });
  };

  const toggleUomStatus = useMutation({
    mutationFn: (row: UomRow) =>
      apiFetch<{ uom: UomRow }>(`/api/uoms/${row.id}`, {
        method: "PUT",
        body: JSON.stringify({
          status: row.status === "ACTIVE" ? "INACTIVE" : "ACTIVE",
        }),
      }),
    onSuccess: (_data, row) => {
      toast.success(
        row.status === "ACTIVE"
          ? `واحد «${row.name}» غیرفعال شد.`
          : `واحد «${row.name}» فعال شد.`
      );
      queryClient.invalidateQueries({ queryKey: ["uoms"] });
      setStatusUom(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // units table: search / status filter / sort / pagination
  const [uomSearch, setUomSearch] = React.useState("");
  const [uomStatusFilter, setUomStatusFilter] = React.useState("all");
  const filteredUoms = React.useMemo(
    () =>
      (uomsQ.data?.uoms ?? []).filter(
        (r) =>
          (uomStatusFilter === "all" || r.status === uomStatusFilter) &&
          searchMatch(`${r.code} ${r.name} ${r.symbol}`, uomSearch)
      ),
    [uomsQ.data, uomSearch, uomStatusFilter]
  );
  const { sorted: sortedUoms, sort: uomSort, toggleSort: toggleUomSort } = useSortedRows<UomRow>(
    filteredUoms,
    React.useMemo(
      () => ({
        code: (r) => r.code,
        name: (r) => r.name,
        symbol: (r) => r.symbol,
        status: (r) => r.status,
      }),
      []
    )
  );
  const uomPaging = usePagedRows(sortedUoms, 15);
  const uomHasFilter = !!uomSearch.trim() || uomStatusFilter !== "all";

  // ============================================================
  // Tab 2: conversions
  // ============================================================

  const [itemFilter, setItemFilter] = React.useState<string | null>(null);

  const conversionsQ = useQuery({
    queryKey: ["uom-conversions", itemFilter],
    queryFn: () =>
      apiFetch<{ conversions: ConversionRow[] }>(
        `/api/uom-conversions${itemFilter ? `?itemId=${itemFilter}` : ""}`
      ),
  });

  const [convDialogOpen, setConvDialogOpen] = React.useState(false);
  const [convForm, setConvForm] = React.useState<ConvFormState>(EMPTY_CONV_FORM);
  const [savedConvJson, setSavedConvJson] = React.useState(JSON.stringify(EMPTY_CONV_FORM));
  const [convErrors, setConvErrors] = React.useState<Record<string, string | undefined>>({});
  const [deleteConv, setDeleteConv] = React.useState<ConversionRow | null>(null);

  const convDirty = convDialogOpen && JSON.stringify(convForm) !== savedConvJson;

  const clearConvError = (key: string) =>
    setConvErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));

  const openConvCreate = () => {
    setConvForm(EMPTY_CONV_FORM);
    setSavedConvJson(JSON.stringify(EMPTY_CONV_FORM));
    setConvErrors({});
    setConvDialogOpen(true);
  };

  const createConversion = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch<{ conversion: ConversionRow }>("/api/uom-conversions", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      toast.success("تبدیل واحد با موفقیت ثبت شد.");
      queryClient.invalidateQueries({ queryKey: ["uom-conversions"] });
      setConvDialogOpen(false);
    },
    // Duplicate per-item conversions are enforced by the server — surfaced via toast.
    onError: (e: Error) => toast.error(e.message),
  });

  const submitConversion = () => {
    const next: Record<string, string | undefined> = {};
    if (!convForm.itemId) next.itemId = "لطفاً جنس را انتخاب کنید.";
    if (!convForm.fromUomId) next.fromUomId = "لطفاً واحد مبدأ را انتخاب کنید.";
    if (!convForm.toUomId) next.toUomId = "لطفاً واحد مقصد را انتخاب کنید.";
    if (convForm.fromUomId && convForm.fromUomId === convForm.toUomId)
      next.toUomId = "واحد مبدأ و مقصد نمی‌توانند یکسان باشند.";
    const factor = Number(convForm.conversionFactor);
    if (!convForm.conversionFactor.trim() || Number.isNaN(factor) || factor <= 0)
      next.conversionFactor = "لطفاً ضریب تبدیل معتبر (بزرگ‌تر از صفر) وارد کنید.";
    setConvErrors(next);
    if (Object.values(next).some(Boolean)) return;
    createConversion.mutate({
      itemId: Number(convForm.itemId),
      fromUomId: Number(convForm.fromUomId),
      toUomId: Number(convForm.toUomId),
      conversionFactor: factor,
    });
  };

  const deleteConversion = useMutation({
    mutationFn: (row: ConversionRow) =>
      apiFetch<{ success: boolean }>(`/api/uom-conversions/${row.id}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success("تبدیل واحد با موفقیت حذف شد.");
      queryClient.invalidateQueries({ queryKey: ["uom-conversions"] });
      setDeleteConv(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const conversions = conversionsQ.data?.conversions ?? [];

  // ---------- live calculation example (updates as you type) ----------
  const fromUom = activeUoms.find((u) => String(u.id) === convForm.fromUomId);
  const toUom = activeUoms.find((u) => String(u.id) === convForm.toUomId);
  const fromSym = fromUom?.symbol ?? "—";
  const toSym = toUom?.symbol ?? "—";
  const factorNum = Number(convForm.conversionFactor);
  const factorValid =
    convForm.conversionFactor.trim() !== "" && Number.isFinite(factorNum) && factorNum > 0;
  const factorText = factorValid ? toPersianDigits(convForm.conversionFactor) : "—";
  const scaledText = factorValid ? formatNumber(100 * factorNum) : "—";

  return (
    <div>
      <PageHeader
        breadcrumbs={breadcrumbItems("uoms")}
        title="واحدات اندازه‌گیری"
        description="مدیریت واحدات اندازه‌گیری و تعریف ضرایب تبدیل میان واحدات."
        actions={
          isAdmin && (
            <Button size="sm" onClick={openUomCreate}>
              <Plus className="size-4" />
              واحد جدید
            </Button>
          )
        }
      />

      <Tabs defaultValue="uoms" className="w-full">
        <TabsList className="mb-3">
          <TabsTrigger value="uoms" className="gap-1.5">
            <Ruler className="size-4" />
            واحدات
          </TabsTrigger>
          <TabsTrigger value="conversions" className="gap-1.5">
            <ArrowLeftRight className="size-4" />
            تبدیلات
          </TabsTrigger>
        </TabsList>

        {/* ================= Tab 1: units ================= */}
        <TabsContent value="uoms" className="mt-0">
          <TableShell
            toolbar={
              <TableToolbar
                value={uomSearch}
                onChange={setUomSearch}
                placeholder="جستجو به اساس کود، نام یا علامت واحد…"
              >
                <Select value={uomStatusFilter} onValueChange={setUomStatusFilter}>
                  <SelectTrigger className="sm:w-40 h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">همه وضعیت‌ها</SelectItem>
                    <SelectItem value="ACTIVE">{STATUS_LABELS.ACTIVE}</SelectItem>
                    <SelectItem value="INACTIVE">{STATUS_LABELS.INACTIVE}</SelectItem>
                  </SelectContent>
                </Select>
                <div className="text-xs text-muted-foreground hidden sm:flex items-center px-2">
                  {uomsQ.isLoading
                    ? "در حال بارگیری..."
                    : `مجموعه: ${toPersianDigits(filteredUoms.length)} واحد`}
                </div>
              </TableToolbar>
            }
            footer={
              <TablePagination
                page={uomPaging.page}
                pageCount={uomPaging.pageCount}
                total={uomPaging.total}
                onPage={uomPaging.setPage}
                entityLabel="واحد"
              />
            }
          >
            {uomsQ.isLoading ? (
              <TableSkeleton rows={6} cols={6} />
            ) : filteredUoms.length === 0 ? (
              <EmptyState
                icon={<Ruler className="size-10" />}
                title={
                  uomHasFilter ? "هیچ واحدی مطابق جستجو یافت نشد" : "هیچ واحد اندازه‌گیری ثبت نشده است"
                }
                description={
                  uomHasFilter
                    ? "عبارت جستجو یا فیلتر وضعیت را تغییر دهید."
                    : "برای شروع، یک واحد جدید ایجاد نمایید."
                }
                action={
                  isAdmin && !uomHasFilter ? (
                    <Button size="sm" onClick={openUomCreate}>
                      <Plus className="size-4" />
                      واحد جدید
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <div className="min-w-[640px]">
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-muted">
                    <TableRow>
                      <SortHead label="کود" k="code" sort={uomSort} onSort={toggleUomSort} />
                      <SortHead label="نام واحد" k="name" sort={uomSort} onSort={toggleUomSort} />
                      <SortHead label="علامت" k="symbol" sort={uomSort} onSort={toggleUomSort} />
                      <TableHead className="text-center hidden md:table-cell">تعداد اجناس</TableHead>
                      <SortHead label="وضعیت" k="status" sort={uomSort} onSort={toggleUomSort} />
                      <TableHead className="no-print">عملیات</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {uomPaging.paged.map((row) => (
                      <TableRow key={row.id} className="hover:bg-muted/40">
                        <TableCell dir="ltr" className="font-mono text-xs text-right align-middle">
                          {row.code}
                        </TableCell>
                        <TableCell className="font-medium align-middle">
                          <span className="block max-w-[14rem] truncate" title={row.name}>
                            {row.name}
                          </span>
                        </TableCell>
                        <TableCell className="align-middle">{row.symbol}</TableCell>
                        <TableCell className="text-center align-middle tabular-nums hidden md:table-cell">
                          {toPersianDigits(row._count.items)}
                        </TableCell>
                        <TableCell className="align-middle">
                          <ActiveStatusBadge status={row.status} />
                        </TableCell>
                        <TableCell className="align-middle no-print">
                          {isAdmin ? (
                            <div className="flex items-center gap-1.5 whitespace-nowrap">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => openUomEdit(row)}
                                aria-label={`ویرایش واحد ${row.name}`}
                              >
                                <Pencil className="size-3.5" />
                                ویرایش
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                className={row.status === "ACTIVE" ? "text-danger" : "text-success"}
                                onClick={() => setStatusUom(row)}
                                aria-label={
                                  row.status === "ACTIVE"
                                    ? `غیرفعال‌سازی واحد ${row.name}`
                                    : `فعال‌سازی واحد ${row.name}`
                                }
                              >
                                <Power className="size-3.5" />
                                {row.status === "ACTIVE" ? "غیرفعال‌سازی" : "فعال‌سازی"}
                              </Button>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TableShell>
        </TabsContent>

        {/* ================= Tab 2: conversions ================= */}
        <TabsContent value="conversions" className="mt-0 space-y-3">
          <div className="rounded-lg border bg-muted/50 p-3 flex items-start gap-2 text-xs leading-6 text-muted-foreground">
            <Info className="size-4 mt-1 shrink-0 text-gold" />
            <span>
              ضریب تبدیل: مقدار در واحد مبدأ × ضریب = مقدار در واحد مقصد.
              مثال: ۱ تن × ۱۰۰۰ = ۱۰۰۰ کیلوگرام
            </span>
          </div>

          <TableShell
            toolbar={
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
                <div className="w-full sm:w-72">
                  <SearchSelect
                    value={itemFilter}
                    onChange={(v) => setItemFilter(v)}
                    options={toOptions(
                      activeItems,
                      (it) => it.id,
                      (it) => it.itemName,
                      (it) => it.itemCode
                    )}
                    placeholder="همه اجناس"
                    searchPlaceholder="جستجوی جنس…"
                    loading={activeItemsQ.isLoading}
                    allowClear
                    aria-label="فیلتر تبدیل‌ها به اساس جنس"
                  />
                </div>
                {isAdmin && (
                  <Button size="sm" onClick={openConvCreate}>
                    <Plus className="size-4" />
                    تبدیل جدید
                  </Button>
                )}
              </div>
            }
            maxHeight="65vh"
          >
            {conversionsQ.isLoading ? (
              <TableSkeleton rows={5} cols={5} />
            ) : conversions.length === 0 ? (
              <EmptyState
                icon={<ArrowLeftRight className="size-10" />}
                title={
                  itemFilter
                    ? "هیچ تبدیلی برای این جنس ثبت نشده است"
                    : "هیچ تبدیل واحد تعریف نشده است"
                }
                description="برای تبدیل مقدار میان واحدات، یک تبدیل جدید تعریف نمایید."
                action={
                  isAdmin ? (
                    <Button size="sm" onClick={openConvCreate}>
                      <Plus className="size-4" />
                      تبدیل جدید
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <div className="min-w-[640px]">
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-muted">
                    <TableRow>
                      <TableHead>جنس</TableHead>
                      <TableHead>از واحد</TableHead>
                      <TableHead>به واحد</TableHead>
                      <TableHead className="text-center">ضریب تبدیل</TableHead>
                      <TableHead className="no-print">عملیات</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {conversions.map((row) => (
                      <TableRow key={row.id} className="hover:bg-muted/40">
                        <TableCell className="font-medium align-middle">
                          <span
                            className="block max-w-[16rem] truncate"
                            title={`${row.item.itemName} (${row.item.itemCode})`}
                          >
                            {row.item.itemName}{" "}
                            <span dir="ltr" className="font-mono text-xs text-muted-foreground">
                              ({row.item.itemCode})
                            </span>
                          </span>
                        </TableCell>
                        <TableCell className="align-middle">
                          {row.fromUom.name}{" "}
                          <Badge variant="outline" className="font-normal">{row.fromUom.symbol}</Badge>
                        </TableCell>
                        <TableCell className="align-middle">
                          {row.toUom.name}{" "}
                          <Badge variant="outline" className="font-normal">{row.toUom.symbol}</Badge>
                        </TableCell>
                        <TableCell className="text-center align-middle font-bold tabular-nums">
                          {formatNumber(row.conversionFactor)}
                        </TableCell>
                        <TableCell className="align-middle no-print">
                          {isAdmin ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="whitespace-nowrap text-danger"
                              onClick={() => setDeleteConv(row)}
                              aria-label={`حذف تبدیل جنس ${row.item.itemName}`}
                            >
                              <Trash2 className="size-3.5" />
                              حذف
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TableShell>
        </TabsContent>
      </Tabs>

      {/* ---------- Create / edit unit dialog ---------- */}
      <FormDialog
        open={uomDialogOpen}
        onOpenChange={setUomDialogOpen}
        title={editingUom ? "ویرایش واحد" : "ثبت واحد جدید"}
        description="واحد اندازه‌گیری مانند تن، کیلوگرام، لیتر و غیره را مدیریت نمایید."
        icon={<Ruler className="size-5 text-primary shrink-0" />}
        size="sm"
        busy={saveUom.isPending}
        dirty={uomDirty}
        onSubmit={submitUom}
        submitLabel="ذخیره"
      >
        <FormSection title="معلومات واحد" description="کود، نام و علامت واحد اندازه‌گیری را درج نمایید.">
          <FieldBlock
            label="کود واحد (رسمی)"
            htmlFor="uom-code"
            error={uomErrors.code}
            hint="اختیاری — کود رسمی (نمونه: LTR، KGM). در صورت خالی بودن، کود داخلی خودکار تولید می‌شود."
          >
            <Input
              id="uom-code"
              dir="ltr"
              className="text-left font-mono uppercase"
              placeholder="مثلاً KG"
              value={uomForm.code}
              onChange={(e) => {
                setUomForm((s) => ({ ...s, code: e.target.value }));
                clearUomError("code");
              }}
              aria-invalid={!!uomErrors.code}
            />
          </FieldBlock>
          <FieldBlock label="نام واحد" htmlFor="uom-name" required error={uomErrors.name}>
            <Input
              id="uom-name"
              placeholder="مثلاً کیلوگرام"
              value={uomForm.name}
              onChange={(e) => {
                setUomForm((s) => ({ ...s, name: e.target.value }));
                clearUomError("name");
              }}
              aria-invalid={!!uomErrors.name}
            />
          </FieldBlock>
          <FieldBlock label="علامت" htmlFor="uom-symbol" required error={uomErrors.symbol}>
            <Input
              id="uom-symbol"
              placeholder="مثلاً ل"
              value={uomForm.symbol}
              onChange={(e) => {
                setUomForm((s) => ({ ...s, symbol: e.target.value }));
                clearUomError("symbol");
              }}
              aria-invalid={!!uomErrors.symbol}
            />
          </FieldBlock>
          <FieldBlock label="وضعیت" htmlFor="uom-status">
            <Select
              value={uomForm.status}
              onValueChange={(v) => setUomForm((s) => ({ ...s, status: v }))}
            >
              <SelectTrigger id="uom-status" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ACTIVE">{STATUS_LABELS.ACTIVE}</SelectItem>
                <SelectItem value="INACTIVE">{STATUS_LABELS.INACTIVE}</SelectItem>
              </SelectContent>
            </Select>
          </FieldBlock>
        </FormSection>
      </FormDialog>

      {/* ---------- Unit status confirm ---------- */}
      <ConfirmDialog
        open={!!statusUom}
        onOpenChange={(v) => !v && setStatusUom(null)}
        title={statusUom?.status === "ACTIVE" ? "غیرفعال‌سازی واحد" : "فعال‌سازی واحد"}
        description={
          statusUom
            ? statusUom.status === "ACTIVE"
              ? `آیا از غیرفعال‌سازی واحد «${statusUom.name}» مطمئن هستید؟`
              : `آیا از فعال‌سازی مجدد واحد «${statusUom.name}» مطمئن هستید؟`
            : ""
        }
        confirmLabel={statusUom?.status === "ACTIVE" ? "غیرفعال‌سازی" : "فعال‌سازی"}
        destructive={statusUom?.status === "ACTIVE"}
        busy={toggleUomStatus.isPending}
        onConfirm={() => statusUom && toggleUomStatus.mutate(statusUom)}
      />

      {/* ---------- Create conversion dialog (with live calculation example) ---------- */}
      <FormDialog
        open={convDialogOpen}
        onOpenChange={setConvDialogOpen}
        title="تعریف تبدیل واحد"
        description="برای یک جنس، ضریب تبدیل از واحد مبدأ به واحد مقصد را تعیین نمایید."
        icon={<ArrowLeftRight className="size-5 text-primary shrink-0" />}
        size="sm"
        busy={createConversion.isPending}
        dirty={convDirty}
        onSubmit={submitConversion}
        submitLabel="ذخیره"
      >
        <FormSection
          title="معلومات تبدیل"
          description="تبدیل برای هر جنس به‌صورت جداگانه تعریف می‌شود."
          columns={1}
        >
          <FieldBlock label="جنس" htmlFor="conv-item" required error={convErrors.itemId}>
            <SearchSelect
              id="conv-item"
              value={convForm.itemId || null}
              onChange={(v) => {
                setConvForm((s) => ({ ...s, itemId: v ?? "" }));
                clearConvError("itemId");
              }}
              options={toOptions(
                activeItems,
                (it) => it.id,
                (it) => it.itemName,
                (it) => it.itemCode
              )}
              placeholder="انتخاب جنس"
              searchPlaceholder="جستجوی جنس…"
              loading={activeItemsQ.isLoading}
              invalid={!!convErrors.itemId}
            />
          </FieldBlock>
          <FieldBlock label="واحد مبدأ" htmlFor="conv-from" required error={convErrors.fromUomId}>
            <SearchSelect
              id="conv-from"
              value={convForm.fromUomId || null}
              onChange={(v) => {
                setConvForm((s) => ({ ...s, fromUomId: v ?? "" }));
                clearConvError("fromUomId");
                clearConvError("toUomId");
              }}
              options={toOptions(
                activeUoms,
                (u) => u.id,
                (u) => u.name,
                (u) => `(${u.symbol})`
              )}
              placeholder="انتخاب واحد مبدأ"
              searchPlaceholder="جستجوی واحد…"
              invalid={!!convErrors.fromUomId}
            />
          </FieldBlock>
          <FieldBlock
            label="واحد مقصد"
            htmlFor="conv-to"
            required
            error={convErrors.toUomId}
            hint="واحد مقصد باید با واحد مبدأ متفاوت باشد."
          >
            <SearchSelect
              id="conv-to"
              value={convForm.toUomId || null}
              onChange={(v) => {
                setConvForm((s) => ({ ...s, toUomId: v ?? "" }));
                clearConvError("toUomId");
              }}
              options={toOptions(
                activeUoms,
                (u) => u.id,
                (u) => u.name,
                (u) => `(${u.symbol})`
              )}
              placeholder="انتخاب واحد مقصد"
              searchPlaceholder="جستجوی واحد…"
              invalid={!!convErrors.toUomId}
            />
          </FieldBlock>
          <FieldBlock
            label="ضریب تبدیل"
            htmlFor="conv-factor"
            required
            error={convErrors.conversionFactor}
            hint="مقدار در واحد مبدأ × ضریب = مقدار در واحد مقصد."
          >
            <Input
              id="conv-factor"
              dir="ltr"
              className="text-left font-mono"
              type="number"
              step="0.001"
              min="0.001"
              placeholder="مثلاً 1000"
              value={convForm.conversionFactor}
              onChange={(e) => {
                setConvForm((s) => ({ ...s, conversionFactor: e.target.value }));
                clearConvError("conversionFactor");
              }}
              aria-invalid={!!convErrors.conversionFactor}
            />
          </FieldBlock>
        </FormSection>

        {/* Live example — recalculates as the fields change */}
        <div className="rounded-lg bg-muted p-3 space-y-1.5" aria-live="polite">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Calculator className="size-3.5" />
            مثال محاسبهٔ تبدیل
          </div>
          <div className="text-sm font-medium text-foreground">
            ۱ {fromSym} × {factorText} = {factorText} {toSym}
          </div>
          <div className="text-sm text-muted-foreground">
            {formatNumber(100)} {fromSym} = {scaledText} {toSym}
          </div>
        </div>
      </FormDialog>

      {/* ---------- Delete conversion confirm ---------- */}
      <ConfirmDialog
        open={!!deleteConv}
        onOpenChange={(v) => !v && setDeleteConv(null)}
        title="حذف تبدیل واحد"
        description={
          deleteConv
            ? `آیا از حذف تبدیل «${deleteConv.fromUom.name} → ${deleteConv.toUom.name}» برای جنس «${deleteConv.item.itemName}» مطمئن هستید؟ این عملیه قابل بازگشت نیست.`
            : ""
        }
        confirmLabel="حذف"
        destructive
        busy={deleteConversion.isPending}
        onConfirm={() => deleteConv && deleteConversion.mutate(deleteConv)}
      />
    </div>
  );
}

export { UomsView };
export default UomsView;
