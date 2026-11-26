"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  FolderTree,
  Package,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { apiFetch } from "@/lib/client-api";
import { toPersianDigits } from "@/lib/jalali";
import { STATUS_LABELS } from "@/lib/constants";
import { breadcrumbItems } from "@/lib/nav";
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
// اجناس — master data management view
// ============================================================

interface UomLite {
  id: number;
  code: string;
  name: string;
  symbol: string;
  status: string;
}

interface CategoryRow {
  id: number;
  name: string;
  status: string;
}

interface ItemRow {
  id: number;
  itemCode: string;
  itemName: string;
  categoryId: number | null;
  baseUomId: number;
  status: string;
  description: string | null;
  category: { id: number; name: string } | null;
  baseUom: { id: number; code: string; name: string; symbol: string };
  _count: { entryItems: number; limits: number };
}

const NONE_SENTINEL = "__none__";

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
      <Label htmlFor={htmlFor}>
        {label}
        {required && <span className="text-danger"> *</span>}
      </Label>
      {children}
      {error && <FieldError message={error} />}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

interface ItemFormState {
  itemCode: string;
  itemName: string;
  categoryId: string; // NONE_SENTINEL = بدون دسته
  baseUomId: string; // "" = انتخاب‌نشده
  status: string;
  description: string;
}

const EMPTY_FORM: ItemFormState = {
  itemCode: "",
  itemName: "",
  categoryId: NONE_SENTINEL,
  baseUomId: "",
  status: "ACTIVE",
  description: "",
};

function ItemsView() {
  const user = useAppStore((s) => s.user);
  const isAdmin = user?.role === "ADMIN";
  const queryClient = useQueryClient();

  // Debounced server-side search (300ms)
  const [search, setSearch] = React.useState("");
  const [q, setQ] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const itemsQ = useQuery({
    queryKey: ["items", q],
    queryFn: () =>
      apiFetch<{ items: ItemRow[] }>(
        `/api/items${q ? `?q=${encodeURIComponent(q)}` : ""}`
      ),
  });

  const uomsQ = useQuery({
    queryKey: ["uoms"],
    queryFn: () => apiFetch<{ uoms: UomLite[] }>("/api/uoms"),
  });

  const categoriesQ = useQuery({
    queryKey: ["categories"],
    queryFn: () => apiFetch<{ categories: CategoryRow[] }>("/api/categories"),
  });

  // ---------- create / edit item dialog ----------
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ItemRow | null>(null);
  const [form, setForm] = React.useState<ItemFormState>(EMPTY_FORM);
  const [savedJson, setSavedJson] = React.useState(JSON.stringify(EMPTY_FORM));
  const [errors, setErrors] = React.useState<Record<string, string | undefined>>({});

  const dirty = dialogOpen && JSON.stringify(form) !== savedJson;

  const clearError = (key: string) =>
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));

  const openCreate = () => {
    setEditing(null);
    // Single-UOM default — when exactly one active unit exists (e.g. لیتر),
    // preselect it as the base unit instead of forcing a manual pick.
    const activeUoms = uoms.filter((u) => u.status === "ACTIVE");
    const next: ItemFormState = {
      ...EMPTY_FORM,
      baseUomId: activeUoms.length === 1 ? String(activeUoms[0].id) : "",
    };
    setForm(next);
    setSavedJson(JSON.stringify(next));
    setErrors({});
    setDialogOpen(true);
  };

  const openEdit = (row: ItemRow) => {
    setEditing(row);
    const next: ItemFormState = {
      itemCode: row.itemCode,
      itemName: row.itemName,
      categoryId: row.categoryId ? String(row.categoryId) : NONE_SENTINEL,
      baseUomId: String(row.baseUomId),
      status: row.status,
      description: row.description ?? "",
    };
    setForm(next);
    setSavedJson(JSON.stringify(next));
    setErrors({});
    setDialogOpen(true);
  };

  const saveItem = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      editing
        ? apiFetch<{ item: ItemRow }>(`/api/items/${editing.id}`, {
            method: "PUT",
            body: JSON.stringify(body),
          })
        : apiFetch<{ item: ItemRow }>("/api/items", {
            method: "POST",
            body: JSON.stringify(body),
          }),
    onSuccess: () => {
      toast.success(
        editing ? "معلومات جنس با موفقیت به‌روزرسانی شد." : "جنس جدید با موفقیت ثبت شد."
      );
      queryClient.invalidateQueries({ queryKey: ["items"] });
      setDialogOpen(false);
    },
    // Duplicate itemCode and other rule violations surface via toast.
    onError: (e: Error) => toast.error(e.message),
  });

  const submitItem = () => {
    const next: Record<string, string | undefined> = {};
    // OFFICIAL code is optional — when left blank the server generates an
    // internal code automatically (ITM-nnn). Official codes are never
    // invented from the item name.
    if (!form.itemName.trim()) next.itemName = "لطفاً نام جنس را بنویسید.";
    if (!form.baseUomId) next.baseUomId = "لطفاً واحد اساس جنس را انتخاب کنید.";
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    saveItem.mutate({
      itemCode: form.itemCode.trim().toUpperCase() || null,
      itemName: form.itemName.trim(),
      categoryId:
        form.categoryId === NONE_SENTINEL ? null : Number(form.categoryId),
      baseUomId: Number(form.baseUomId),
      status: form.status,
      description: form.description.trim() || null,
    });
  };

  // ---------- activate / deactivate ----------
  const [statusRow, setStatusRow] = React.useState<ItemRow | null>(null);
  const toggleStatus = useMutation({
    mutationFn: (row: ItemRow) =>
      apiFetch<{ item: ItemRow }>(`/api/items/${row.id}`, {
        method: "PUT",
        body: JSON.stringify({
          status: row.status === "ACTIVE" ? "INACTIVE" : "ACTIVE",
        }),
      }),
    onSuccess: (_data, row) => {
      toast.success(
        row.status === "ACTIVE"
          ? `جنس «${row.itemName}» غیرفعال شد.`
          : `جنس «${row.itemName}» فعال شد.`
      );
      queryClient.invalidateQueries({ queryKey: ["items"] });
      setStatusRow(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ---------- delete (blocked when entries / limits depend on the item) ----------
  const [deleteRow, setDeleteRow] = React.useState<ItemRow | null>(null);
  const deleteItem = useMutation({
    mutationFn: (row: ItemRow) =>
      apiFetch<{ success: boolean }>(`/api/items/${row.id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("جنس با موفقیت حذف شد.");
      queryClient.invalidateQueries({ queryKey: ["items"] });
      setDeleteRow(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ---------- categories management ----------
  const [categoriesOpen, setCategoriesOpen] = React.useState(false);
  const [newCategory, setNewCategory] = React.useState("");
  const [newCategoryError, setNewCategoryError] = React.useState<string | undefined>(
    undefined
  );
  const createCategory = useMutation({
    mutationFn: (name: string) =>
      apiFetch<{ category: CategoryRow }>("/api/categories", {
        method: "POST",
        body: JSON.stringify({ name, status: "ACTIVE" }),
      }),
    onSuccess: (data) => {
      toast.success("دسته جدید با موفقیت ایجاد شد.");
      setNewCategory("");
      setNewCategoryError(undefined);
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      // INLINE CREATION RETURNS TO THE PARENT FORM with the new category
      // already selected — no re-selection needed.
      if (dialogOpen) {
        setForm((f) => ({ ...f, categoryId: String(data.category.id) }));
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const submitCategory = () => {
    if (!newCategory.trim()) {
      setNewCategoryError("لطفاً نام دسته را بنویسید.");
      return;
    }
    createCategory.mutate(newCategory.trim());
  };

  const items = itemsQ.data?.items ?? [];
  const uoms = uomsQ.data?.uoms ?? [];
  const categories = categoriesQ.data?.categories ?? [];

  // Late-load safety: when the create dialog is open and the UoM list arrives
  // after opening, still preselect the single active base unit. Baseline
  // snapshot is kept in sync so no false "unsaved changes" prompt appears.
  React.useEffect(() => {
    if (!dialogOpen || editing) return;
    if (form.baseUomId) return;
    const active = uoms.filter((u) => u.status === "ACTIVE");
    if (active.length !== 1) return;
    const next = { ...form, baseUomId: String(active[0].id) };
    setForm(next);
    setSavedJson(JSON.stringify(next));
  }, [dialogOpen, editing, uoms, form]);

  // ---------- table state: status filter / sort / pagination ----------
  const [statusFilter, setStatusFilter] = React.useState("all");
  const filteredItems = React.useMemo(
    () => items.filter((r) => statusFilter === "all" || r.status === statusFilter),
    [items, statusFilter]
  );
  const { sorted, sort, toggleSort } = useSortedRows<ItemRow>(
    filteredItems,
    React.useMemo(
      () => ({
        code: (r) => r.itemCode,
        name: (r) => r.itemName,
        category: (r) => r.category?.name ?? null,
        status: (r) => r.status,
      }),
      []
    )
  );
  const paging = usePagedRows(sorted, 15);
  const hasFilter = !!q || statusFilter !== "all";

  return (
    <div>
      <PageHeader
        breadcrumbs={breadcrumbItems("items")}
        title="اجناس"
        description="مدیریت فهرست اجناس وارداتی، دسته‌بندی و واحدات اساس."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => queryClient.invalidateQueries({ queryKey: ["items"] })}
              aria-label="بارگیری مجدد فهرست اجناس"
            >
              <RefreshCw className="size-4" />
              بارگیری مجدد
            </Button>
            {isAdmin && (
              <Button variant="outline" size="sm" onClick={() => setCategoriesOpen(true)}>
                <FolderTree className="size-4" />
                دسته‌بندی‌ها
              </Button>
            )}
            {isAdmin && (
              <Button size="sm" onClick={openCreate}>
                <Plus className="size-4" />
                جنس جدید
              </Button>
            )}
          </>
        }
      />

      <TableShell
        toolbar={
          <TableToolbar
            value={search}
            onChange={setSearch}
            placeholder="جستجو به اساس نام، کود یا توضیحات..."
          >
            <Select value={statusFilter} onValueChange={setStatusFilter}>
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
              {itemsQ.isLoading
                ? "در حال بارگیری..."
                : `مجموعه: ${toPersianDigits(filteredItems.length)} جنس`}
            </div>
          </TableToolbar>
        }
        footer={
          <TablePagination
            page={paging.page}
            pageCount={paging.pageCount}
            total={paging.total}
            onPage={paging.setPage}
            entityLabel="جنس"
          />
        }
      >
        {itemsQ.isLoading ? (
          <TableSkeleton rows={6} cols={6} />
        ) : filteredItems.length === 0 ? (
          <EmptyState
            icon={<Package className="size-10" />}
            title={hasFilter ? "هیچ جنسی مطابق جستجو یافت نشد" : "هیچ جنس ثبت نشده است"}
            description={
              hasFilter
                ? "نتیجه‌ای برای عبارت جستجو یا فیلتر وضعیت پیدا نشد. عبارت دیگر را امتحان کنید."
                : "برای شروع، یک جنس جدید ایجاد نمایید."
            }
            action={
              isAdmin && !hasFilter ? (
                <Button size="sm" onClick={openCreate}>
                  <Plus className="size-4" />
                  جنس جدید
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="min-w-[720px]">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-muted">
                <TableRow>
                  <SortHead label="کود" k="code" sort={sort} onSort={toggleSort} />
                  <SortHead label="نام جنس" k="name" sort={sort} onSort={toggleSort} />
                  <SortHead label="دسته" k="category" sort={sort} onSort={toggleSort} />
                  <TableHead className="hidden md:table-cell">واحد اساس</TableHead>
                  <TableHead className="text-center hidden md:table-cell">ثبت‌ها</TableHead>
                  <SortHead label="وضعیت" k="status" sort={sort} onSort={toggleSort} />
                  <TableHead className="no-print">عملیات</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paging.paged.map((row) => (
                  <TableRow key={row.id} className="hover:bg-muted/40">
                    <TableCell dir="ltr" className="font-mono text-xs text-right align-middle">
                      {row.itemCode}
                    </TableCell>
                    <TableCell className="font-medium align-middle">
                      <span className="block max-w-[16rem] truncate" title={row.itemName}>
                        {row.itemName}
                      </span>
                    </TableCell>
                    <TableCell className="align-middle">
                      {row.category?.name ? (
                        <span className="block max-w-[12rem] truncate" title={row.category.name}>
                          {row.category.name}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="align-middle hidden md:table-cell">
                      {row.baseUom.name}{" "}
                      <span className="text-muted-foreground text-xs">({row.baseUom.symbol})</span>
                    </TableCell>
                    <TableCell className="text-center align-middle tabular-nums hidden md:table-cell">
                      {toPersianDigits(row._count.entryItems)}
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
                            onClick={() => openEdit(row)}
                            aria-label={`ویرایش جنس ${row.itemName}`}
                          >
                            <Pencil className="size-3.5" />
                            ویرایش
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className={row.status === "ACTIVE" ? "text-danger" : "text-success"}
                            onClick={() => setStatusRow(row)}
                            aria-label={
                              row.status === "ACTIVE"
                                ? `غیرفعال‌سازی جنس ${row.itemName}`
                                : `فعال‌سازی جنس ${row.itemName}`
                            }
                          >
                            <Power className="size-3.5" />
                            {row.status === "ACTIVE" ? "غیرفعال‌سازی" : "فعال‌سازی"}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-danger"
                            onClick={() => setDeleteRow(row)}
                            aria-label={`حذف جنس ${row.itemName}`}
                          >
                            <Trash2 className="size-3.5" />
                            حذف
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

      {/* ---------- Create / edit item dialog ---------- */}
      <FormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={editing ? "ویرایش جنس" : "ثبت جنس جدید"}
        description={
          editing
            ? `ویرایش معلومات جنس «${editing.itemName}»`
            : "معلومات جنس جدید را وارد نمایید."
        }
        icon={<Package className="size-5 text-primary shrink-0" />}
        size="md"
        busy={saveItem.isPending}
        dirty={dirty}
        onSubmit={submitItem}
        submitLabel="ذخیره"
      >
        {/* ۱ — مشخصات جنس */}
        <FormSection title="مشخصات جنس" description="کود و نام جنس در فهرست‌های سیستم به همین شکل ثبت می‌شود.">
          <FieldBlock
            label="کود جنس (رسمی)"
            htmlFor="item-code"
            error={errors.itemCode}
            hint="اختیاری — کود رسمی موجود (نمونه: FUEL-092). در صورت خالی گذاشتن، کود داخلی به‌صورت خودکار تولید می‌شود."
          >
            <Input
              id="item-code"
              dir="ltr"
              className="text-left font-mono uppercase"
              placeholder="مثلاً DSL-001"
              value={form.itemCode}
              onChange={(e) => {
                setForm((s) => ({ ...s, itemCode: e.target.value }));
                clearError("itemCode");
              }}
              aria-invalid={!!errors.itemCode}
            />
          </FieldBlock>
          <FieldBlock label="نام جنس" htmlFor="item-name" required error={errors.itemName}>
            <Input
              id="item-name"
              placeholder="مثلاً دیزل"
              value={form.itemName}
              onChange={(e) => {
                setForm((s) => ({ ...s, itemName: e.target.value }));
                clearError("itemName");
              }}
              aria-invalid={!!errors.itemName}
            />
          </FieldBlock>
          <FieldBlock label="دسته" htmlFor="item-category">
            <SearchSelect
              id="item-category"
              value={form.categoryId}
              onChange={(v) => setForm((s) => ({ ...s, categoryId: v ?? NONE_SENTINEL }))}
              options={[
                { value: NONE_SENTINEL, label: "بدون دسته" },
                ...toOptions(
                  categories.filter(
                    (c) => c.status === "ACTIVE" || c.id === editing?.categoryId
                  ),
                  (c) => c.id,
                  (c) => (c.status === "INACTIVE" ? `${c.name} (غیرفعال)` : c.name)
                ),
              ]}
              placeholder="انتخاب دسته"
              searchPlaceholder="جستجوی دسته…"
              loading={categoriesQ.isLoading}
            />
          </FieldBlock>
          <FieldBlock label="توضیحات" htmlFor="item-description" span>
            <Textarea
              id="item-description"
              rows={3}
              placeholder="توضیحات اختیاری درباره جنس..."
              value={form.description}
              onChange={(e) => setForm((s) => ({ ...s, description: e.target.value }))}
            />
          </FieldBlock>
        </FormSection>

        {/* ۲ — واحد اساس */}
        <FormSection
          title="واحد اساس"
          description="واحد اندازه‌گیری مبنای جنس که سهمیه‌ها بر اساس آن محاسبه می‌شوند."
          columns={1}
        >
          <FieldBlock
            label="واحد اساس"
            htmlFor="item-base-uom"
            required
            error={errors.baseUomId}
            hint="واحد اساس مبنای محاسبهٔ سهمیه است و پس از ثبت قابل تغییر نیست."
          >
            <SearchSelect
              id="item-base-uom"
              value={form.baseUomId || null}
              onChange={(v) => {
                if (editing) return;
                setForm((s) => ({ ...s, baseUomId: v ?? "" }));
                clearError("baseUomId");
              }}
              options={toOptions(
                uoms,
                (u) => u.id,
                (u) => (u.status === "INACTIVE" ? `${u.name} — غیرفعال` : u.name),
                (u) => `(${u.symbol})`
              )}
              placeholder="انتخاب واحد اساس"
              searchPlaceholder="جستجوی واحد…"
              loading={uomsQ.isLoading}
              invalid={!!errors.baseUomId}
              disabled={!!editing}
              disabledHint={
                editing
                  ? `${editing.baseUom.name} (${editing.baseUom.symbol}) — قابل تغییر نیست`
                  : undefined
              }
            />
          </FieldBlock>
        </FormSection>

        {/* ۳ — وضعیت */}
        <FormSection title="وضعیت" description="جنس غیرفعال در ثبت‌های جدید قابل انتخاب نیست." columns={1}>
          <FieldBlock label="وضعیت جنس" htmlFor="item-status">
            <Select
              value={form.status}
              onValueChange={(v) => setForm((s) => ({ ...s, status: v }))}
            >
              <SelectTrigger id="item-status" className="w-full sm:w-56">
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

      {/* ---------- Activate / deactivate confirm ---------- */}
      <ConfirmDialog
        open={!!statusRow}
        onOpenChange={(v) => !v && setStatusRow(null)}
        title={statusRow?.status === "ACTIVE" ? "غیرفعال‌سازی جنس" : "فعال‌سازی جنس"}
        description={
          statusRow
            ? statusRow.status === "ACTIVE"
              ? `آیا از غیرفعال‌سازی جنس «${statusRow.itemName}» مطمئن هستید؟ جنس غیرفعال در ثبت‌های جدید قابل انتخاب نخواهد بود.`
              : `آیا از فعال‌سازی مجدد جنس «${statusRow.itemName}» مطمئن هستید؟`
            : ""
        }
        confirmLabel={statusRow?.status === "ACTIVE" ? "غیرفعال‌سازی" : "فعال‌سازی"}
        destructive={statusRow?.status === "ACTIVE"}
        busy={toggleStatus.isPending}
        onConfirm={() => statusRow && toggleStatus.mutate(statusRow)}
      />

      {/* ---------- Delete confirm ---------- */}
      <ConfirmDialog
        open={!!deleteRow}
        onOpenChange={(v) => !v && setDeleteRow(null)}
        title="حذف جنس"
        description={
          deleteRow
            ? `آیا از حذف جنس «${deleteRow.itemName}» مطمئن هستید؟ در صورت وجود ثبت واردات یا حد مجاز وابسته، حذف ممکن نخواهد بود.`
            : ""
        }
        confirmLabel="حذف"
        destructive
        busy={deleteItem.isPending}
        onConfirm={() => deleteRow && deleteItem.mutate(deleteRow)}
      />

      {/* ---------- Categories management ---------- */}
      <FormDialog
        open={categoriesOpen}
        onOpenChange={setCategoriesOpen}
        title="دسته‌بندی اجناس"
        description="دسته‌های موجود را مشاهده و دسته جدید ایجاد نمایید."
        icon={<FolderTree className="size-5 text-primary shrink-0" />}
        size="sm"
        onSubmit={isAdmin ? submitCategory : undefined}
        submitLabel="افزودن"
        submitDisabled={!newCategory.trim() || createCategory.isPending}
        busy={createCategory.isPending}
      >
        {isAdmin ? (
          <FieldBlock label="نام دسته جدید" htmlFor="new-category" required error={newCategoryError}>
            <Input
              id="new-category"
              value={newCategory}
              onChange={(e) => {
                setNewCategory(e.target.value);
                setNewCategoryError(undefined);
              }}
              placeholder="مثلاً مواد نفتی"
              aria-label="نام دسته جدید"
              aria-invalid={!!newCategoryError}
            />
          </FieldBlock>
        ) : (
          <p className="text-xs text-muted-foreground">
            تنها مدیر سیستم می‌تواند دسته جدید ایجاد کند.
          </p>
        )}

        <div className="rounded-xl border max-h-64 overflow-y-auto">
          <div className="divide-y">
            {categoriesQ.isLoading ? (
              <div className="p-3 space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-5 rounded bg-muted animate-pulse" />
                ))}
              </div>
            ) : categories.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground text-center">
                هنوز دسته‌ای ثبت نشده است.
              </div>
            ) : (
              categories.map((c) => (
                <div key={c.id} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span className="font-medium">{c.name}</span>
                  <ActiveStatusBadge status={c.status} />
                </div>
              ))
            )}
          </div>
        </div>
      </FormDialog>
    </div>
  );
}

export { ItemsView };
export default ItemsView;
