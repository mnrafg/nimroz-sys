"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { MapPin, Pencil, Plus, Power, Ship } from "lucide-react";
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
import { apiFetch } from "@/lib/client-api";
import { toPersianDigits } from "@/lib/jalali";
import { AFGHAN_PROVINCES, STATUS_LABELS } from "@/lib/constants";
import { SearchSelect } from "@/components/ui/search-select";
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
// بنادر مرزی (Ports) — management view
// ============================================================

interface CheckpointRow {
  id: number;
  code: string;
  name: string;
  province: string;
  status: string;
  _count: { users: number; entries: number; limits: number };
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

interface CheckpointFormState {
  code: string;
  name: string;
  province: string;
  status: string;
}

const EMPTY_FORM: CheckpointFormState = {
  code: "",
  name: "",
  province: "",
  status: "ACTIVE",
};

function CheckpointsView() {
  const user = useAppStore((s) => s.user);
  const isAdmin = user?.role === "ADMIN";
  const queryClient = useQueryClient();

  const checkpointsQ = useQuery({
    queryKey: ["checkpoints"],
    queryFn: () => apiFetch<{ checkpoints: CheckpointRow[] }>("/api/checkpoints"),
  });

  // ---------- table state: search / filter / sort / pagination ----------
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("all");

  const rows = React.useMemo(() => {
    const all = checkpointsQ.data?.checkpoints ?? [];
    return all.filter(
      (r) =>
        (statusFilter === "all" || r.status === statusFilter) &&
        searchMatch(`${r.code} ${r.name} ${r.province}`, search)
    );
  }, [checkpointsQ.data, search, statusFilter]);

  const { sorted, sort, toggleSort } = useSortedRows<CheckpointRow>(
    rows,
    React.useMemo(
      () => ({
        code: (r) => r.code,
        name: (r) => r.name,
        province: (r) => r.province,
        status: (r) => r.status,
      }),
      []
    )
  );
  const paging = usePagedRows(sorted, 15);
  const hasFilter = !!search.trim() || statusFilter !== "all";

  // ---------- create / edit dialog ----------
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<CheckpointRow | null>(null);
  const [form, setForm] = React.useState<CheckpointFormState>(EMPTY_FORM);
  const [savedJson, setSavedJson] = React.useState(JSON.stringify(EMPTY_FORM));
  const [errors, setErrors] = React.useState<Record<string, string | undefined>>({});

  const dirty = dialogOpen && JSON.stringify(form) !== savedJson;

  const clearError = (key: string) =>
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setSavedJson(JSON.stringify(EMPTY_FORM));
    setErrors({});
    setDialogOpen(true);
  };

  const openEdit = (row: CheckpointRow) => {
    setEditing(row);
    const next: CheckpointFormState = {
      code: row.code,
      name: row.name,
      province: row.province,
      status: row.status,
    };
    setForm(next);
    setSavedJson(JSON.stringify(next));
    setErrors({});
    setDialogOpen(true);
  };

  const saveCheckpoint = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      editing
        ? apiFetch<{ checkpoint: CheckpointRow }>(`/api/checkpoints/${editing.id}`, {
            method: "PUT",
            body: JSON.stringify(body),
          })
        : apiFetch<{ checkpoint: CheckpointRow }>("/api/checkpoints", {
            method: "POST",
            body: JSON.stringify(body),
          }),
    onSuccess: () => {
      toast.success(
        editing ? "معلومات بندر با موفقیت به‌روزرسانی شد." : "بندر جدید با موفقیت ثبت شد."
      );
      queryClient.invalidateQueries({ queryKey: ["checkpoints"] });
      setDialogOpen(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const submitCheckpoint = () => {
    const next: Record<string, string | undefined> = {};
    // Official abbreviation (TRK, HRT …) is OPTIONAL — blank generates an
    // internal code (CHP-nn) server-side.

    if (!form.name.trim()) next.name = "لطفاً نام بندر را بنویسید.";
    if (!form.province) next.province = "لطفاً ولایت را انتخاب کنید.";
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    saveCheckpoint.mutate({
      code: form.code.trim().toUpperCase() || null,
      name: form.name.trim(),
      province: form.province,
      status: form.status,
    });
  };

  // ---------- activate / deactivate ----------
  const [statusRow, setStatusRow] = React.useState<CheckpointRow | null>(null);
  const toggleStatus = useMutation({
    mutationFn: (row: CheckpointRow) =>
      apiFetch<{ checkpoint: CheckpointRow }>(`/api/checkpoints/${row.id}`, {
        method: "PUT",
        body: JSON.stringify({
          status: row.status === "ACTIVE" ? "INACTIVE" : "ACTIVE",
        }),
      }),
    onSuccess: (_data, row) => {
      toast.success(
        row.status === "ACTIVE"
          ? `بندر «${row.name}» غیرفعال شد.`
          : `بندر «${row.name}» فعال شد.`
      );
      queryClient.invalidateQueries({ queryKey: ["checkpoints"] });
      setStatusRow(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Keep legacy province spellings selectable when editing old records.
  const provinceOptions = React.useMemo(() => {
    if (editing && editing.province && !AFGHAN_PROVINCES.includes(editing.province)) {
      return [editing.province, ...AFGHAN_PROVINCES];
    }
    return AFGHAN_PROVINCES;
  }, [editing]);

  return (
    <div>
      <PageHeader
        breadcrumbs={breadcrumbItems("checkpoints")}
        title="بنادر مرزی"
        description="ثبت و مدیریت بنادر مرزی"
        actions={
          isAdmin && (
            <Button size="sm" onClick={openCreate}>
              <Plus className="size-4" />
              بندر جدید
            </Button>
          )
        }
      />

      <TableShell
        toolbar={
          <TableToolbar
            value={search}
            onChange={setSearch}
            placeholder="جستجوی بندر، کود یا ولایت…"
          >
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="sm:w-44 h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">همه وضعیت‌ها</SelectItem>
                <SelectItem value="ACTIVE">{STATUS_LABELS.ACTIVE}</SelectItem>
                <SelectItem value="INACTIVE">{STATUS_LABELS.INACTIVE}</SelectItem>
              </SelectContent>
            </Select>
            <div className="text-xs text-muted-foreground hidden sm:flex items-center px-2">
              {checkpointsQ.isLoading
                ? "در حال بارگیری..."
                : `مجموعه: ${toPersianDigits(rows.length)} بندر`}
            </div>
          </TableToolbar>
        }
        footer={
          <TablePagination
            page={paging.page}
            pageCount={paging.pageCount}
            total={paging.total}
            onPage={paging.setPage}
            entityLabel="بندر"
          />
        }
      >
        {checkpointsQ.isLoading ? (
          <TableSkeleton rows={5} cols={6} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Ship className="size-10" />}
            title={hasFilter ? "هیچ بندری مطابق جستجو یافت نشد" : "هیچ بندری ثبت نشده است"}
            description={
              hasFilter
                ? "عبارت جستجو یا فیلتر وضعیت را تغییر دهید."
                : "برای شروع، یک بندر مرزی جدید ثبت نمایید."
            }
            action={
              isAdmin && !hasFilter ? (
                <Button size="sm" onClick={openCreate}>
                  <Plus className="size-4" />
                  بندر جدید
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="min-w-[680px]">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-muted">
                <TableRow>
                  <SortHead label="کود" k="code" sort={sort} onSort={toggleSort} />
                  <SortHead label="نام بندر" k="name" sort={sort} onSort={toggleSort} />
                  <SortHead label="ولایت" k="province" sort={sort} onSort={toggleSort} />
                  <TableHead className="text-center hidden md:table-cell">کاربران</TableHead>
                  <TableHead className="text-center hidden md:table-cell">ثبت‌ها</TableHead>
                  <SortHead label="وضعیت" k="status" sort={sort} onSort={toggleSort} />
                  <TableHead className="no-print">عملیات</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paging.paged.map((row) => (
                  <TableRow key={row.id} className="hover:bg-muted/40">
                    <TableCell dir="ltr" className="font-mono text-xs text-right align-middle">
                      {row.code}
                    </TableCell>
                    <TableCell className="font-medium align-middle">
                      <span className="flex items-center gap-1.5 min-w-0">
                        <Ship className="size-3.5 text-primary/60 shrink-0" />
                        <span className="block max-w-[14rem] truncate" title={row.name}>
                          {row.name}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="align-middle">
                      <Badge variant="outline" className="font-normal gap-1 max-w-[12rem]">
                        <MapPin className="size-3 shrink-0 text-muted-foreground" />
                        <span className="truncate">{row.province}</span>
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center align-middle tabular-nums hidden md:table-cell">
                      {toPersianDigits(row._count.users)}
                    </TableCell>
                    <TableCell className="text-center align-middle tabular-nums hidden md:table-cell">
                      {toPersianDigits(row._count.entries)}
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
                            aria-label={`ویرایش بندر ${row.name}`}
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
                                ? `غیرفعال‌سازی بندر ${row.name}`
                                : `فعال‌سازی بندر ${row.name}`
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

      {/* ---------- Create / edit port dialog ---------- */}
      <FormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={editing ? "ویرایش بندر" : "ثبت بندر جدید"}
        description="معلومات بندر مرزی شامل کود، نام و ولایت مربوط را وارد نمایید."
        icon={<Ship className="size-5 text-primary shrink-0" />}
        size="sm"
        busy={saveCheckpoint.isPending}
        dirty={dirty}
        onSubmit={submitCheckpoint}
        submitLabel="ذخیره"
      >
        {/* ۱ — مشخصات بندر */}
        <FormSection title="مشخصات بندر" description="کود و نام رسمی بندر مرزی را درج نمایید.">
          <FieldBlock
            label="کود بندر (رسمی)"
            htmlFor="cp-code"
            error={errors.code}
            hint="اختیاری — مخفف رسمی (نمونه: TRK). در صورت خالی بودن، کود داخلی خودکار تولید می‌شود."
          >
            <Input
              id="cp-code"
              dir="ltr"
              className="text-left font-mono uppercase"
              placeholder="مثلاً TRK"
              value={form.code}
              onChange={(e) => {
                setForm((s) => ({ ...s, code: e.target.value }));
                clearError("code");
              }}
              aria-invalid={!!errors.code}
            />
          </FieldBlock>
          <FieldBlock label="نام بندر" htmlFor="cp-name" required error={errors.name}>
            <Input
              id="cp-name"
              placeholder="مثلاً بندر تورخم"
              value={form.name}
              onChange={(e) => {
                setForm((s) => ({ ...s, name: e.target.value }));
                clearError("name");
              }}
              aria-invalid={!!errors.name}
            />
          </FieldBlock>
        </FormSection>

        {/* ۲ — موقعیت */}
        <FormSection title="موقعیت" description="ولایت موقعیت بندر از فهرست ولایات افغانستان انتخاب می‌شود.">
          <FieldBlock
            label="ولایت"
            htmlFor="cp-province"
            required
            error={errors.province}
            hint="نام ولایت از فهرست معیار ولایات افغانستان انتخاب می‌شود — قابل جستجو."
          >
            <SearchSelect
              id="cp-province"
              value={form.province || null}
              onChange={(v) => {
                setForm((s) => ({ ...s, province: v ?? "" }));
                clearError("province");
              }}
              options={provinceOptions.map((p) => ({ value: p, label: p }))}
              placeholder="انتخاب ولایت"
              searchPlaceholder="جستجوی ولایت…"
              invalid={!!errors.province}
            />
          </FieldBlock>
          <FieldBlock label="وضعیت" htmlFor="cp-status">
            <Select
              value={form.status}
              onValueChange={(v) => setForm((s) => ({ ...s, status: v }))}
            >
              <SelectTrigger id="cp-status" className="w-full">
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
        title={statusRow?.status === "ACTIVE" ? "غیرفعال‌سازی بندر" : "فعال‌سازی بندر"}
        description={
          statusRow
            ? statusRow.status === "ACTIVE"
              ? `آیا از غیرفعال‌سازی بندر «${statusRow.name}» مطمئن هستید؟ کاربران این بندر دیگر نمی‌توانند ثبت جدید ایجاد کنند.`
              : `آیا از فعال‌سازی مجدد بندر «${statusRow.name}» مطمئن هستید؟`
            : ""
        }
        confirmLabel={statusRow?.status === "ACTIVE" ? "غیرفعال‌سازی" : "فعال‌سازی"}
        destructive={statusRow?.status === "ACTIVE"}
        busy={toggleStatus.isPending}
        onConfirm={() => statusRow && toggleStatus.mutate(statusRow)}
      />
    </div>
  );
}

export { CheckpointsView };
export default CheckpointsView;
