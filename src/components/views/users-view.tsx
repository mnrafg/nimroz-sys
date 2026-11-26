"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Eye, EyeOff, Info, Pencil, Plus, RefreshCw, ShieldAlert, UserCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
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
import { formatJalali } from "@/lib/jalali";
import { ROLE_LABELS } from "@/lib/constants";
import { breadcrumbItems } from "@/lib/nav";
import { cn, searchMatch } from "@/lib/utils";
import {
  ActiveStatusBadge,
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

// ============================================================
// کاربران سیستم — ADMIN-only management view
// ============================================================

interface RoleRow {
  id: number;
  name: string;
  nameDari: string;
  description: string | null;
}

interface CheckpointLite {
  id: number;
  code: string;
  name: string;
  province: string;
  status: string;
}

interface UserRow {
  id: number;
  name: string;
  email: string;
  roleId: number;
  checkpointId: number | null;
  isActive: boolean;
  createdAt: string;
  role: { id: number; name: string; nameDari: string };
  checkpoint: { id: number; name: string } | null;
  _count: { entriesCreated: number };
}

/** Roles bound to a specific border port — a checkpoint is REQUIRED for them. */
const PORT_BOUND_ROLES = ["OFFICER"];

/** Helper text shown under the role select, per role (persists on role change). */
const ROLE_DESCRIPTIONS: Record<string, string> = {
  ADMIN: "مدیر سیستم — دسترسی کامل به همه بنادر و مدیریت سیستم",
  OFFICER: "کارمند ثبت واردات — ثبت واردات و واردکنندگان فقط در بندر مسئولیت خود",
};

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

interface UserFormState {
  name: string;
  email: string;
  password: string;
  roleId: string;
  checkpointId: string; // ALL_SENTINEL = بدون بندر (دسترسی ملی برای مدیر)
  isActive: boolean;
}

const ALL_SENTINEL = "__all__";
const EMPTY_FORM: UserFormState = {
  name: "",
  email: "",
  password: "",
  roleId: "",
  checkpointId: ALL_SENTINEL,
  isActive: true,
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Client-side mirror of the backend password policy (min 8, letter + digit). */
function passwordError(pw: string): string | undefined {
  if (pw.length < 8) return "پاسورد باید حداقل ۸ حرف باشد.";
  if (!/[A-Za-z]/.test(pw)) return "پاسورد باید حداقل یک حرف انگلیسی داشته باشد.";
  if (!/[0-9]/.test(pw)) return "پاسورد باید حداقل یک رقم داشته باشد.";
  return undefined;
}

function UsersView() {
  const user = useAppStore((s) => s.user);
  const isAdmin = user?.role === "ADMIN";
  const queryClient = useQueryClient();

  const usersQ = useQuery({
    queryKey: ["users"],
    queryFn: () => apiFetch<{ users: UserRow[] }>("/api/users"),
    enabled: isAdmin,
  });

  const rolesQ = useQuery({
    queryKey: ["roles"],
    queryFn: () => apiFetch<{ roles: RoleRow[] }>("/api/roles"),
    enabled: isAdmin,
  });

  const checkpointsQ = useQuery({
    queryKey: ["checkpoints"],
    queryFn: () => apiFetch<{ checkpoints: CheckpointLite[] }>("/api/checkpoints"),
    enabled: isAdmin,
  });

  const users = usersQ.data?.users ?? [];
  const roles = rolesQ.data?.roles ?? [];
  const checkpoints = checkpointsQ.data?.checkpoints ?? [];

  // ---------- table state: search / sort / pagination ----------
  const [search, setSearch] = React.useState("");
  const filteredUsers = React.useMemo(
    () =>
      users.filter((r) =>
        searchMatch(`${r.name} ${r.email} ${r.role.nameDari} ${r.checkpoint?.name ?? ""}`, search)
      ),
    [users, search]
  );
  const { sorted, sort, toggleSort } = useSortedRows<UserRow>(
    filteredUsers,
    React.useMemo(
      () => ({
        name: (r) => r.name,
        email: (r) => r.email,
        role: (r) => r.role.nameDari,
        status: (r) => (r.isActive ? 1 : 0),
      }),
      []
    )
  );
  const paging = usePagedRows(sorted, 15);

  // ---------- create / edit dialog ----------
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<UserRow | null>(null);
  const [form, setForm] = React.useState<UserFormState>(EMPTY_FORM);
  const [savedJson, setSavedJson] = React.useState(JSON.stringify(EMPTY_FORM));
  const [errors, setErrors] = React.useState<Record<string, string | undefined>>({});
  const [showPassword, setShowPassword] = React.useState(false);

  const dirty = dialogOpen && JSON.stringify(form) !== savedJson;

  const clearError = (key: string) =>
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setSavedJson(JSON.stringify(EMPTY_FORM));
    setErrors({});
    setShowPassword(false);
    setDialogOpen(true);
  };

  const openEdit = (row: UserRow) => {
    setEditing(row);
    // Password is never prefilled in edit mode.
    const next: UserFormState = {
      name: row.name,
      email: row.email,
      password: "",
      roleId: String(row.roleId),
      checkpointId: row.checkpointId ? String(row.checkpointId) : ALL_SENTINEL,
      isActive: row.isActive,
    };
    setForm(next);
    setSavedJson(JSON.stringify(next));
    setErrors({});
    setShowPassword(false);
    setDialogOpen(true);
  };

  const saveUser = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      editing
        ? apiFetch<{ user: UserRow }>(`/api/users/${editing.id}`, {
            method: "PUT",
            body: JSON.stringify(body),
          })
        : apiFetch<{ user: UserRow }>("/api/users", {
            method: "POST",
            body: JSON.stringify(body),
          }),
    onSuccess: () => {
      toast.success(
        editing ? "معلومات کاربر با موفقیت به‌روزرسانی شد." : "کاربر جدید با موفقیت ایجاد شد."
      );
      queryClient.invalidateQueries({ queryKey: ["users"] });
      setDialogOpen(false);
    },
    // Server-side policy errors (checkpoint requirement, password strength) surface via toast.
    onError: (e: Error) => toast.error(e.message),
  });

  const selectedRole = roles.find((r) => String(r.id) === form.roleId) ?? null;
  const selectedRoleName = selectedRole?.name ?? "";
  const isPortBoundRole = PORT_BOUND_ROLES.includes(selectedRoleName);
  const hasCheckpoint = !!form.checkpointId && form.checkpointId !== ALL_SENTINEL;

  // Single-checkpoint default — port-bound roles (OFFICER): when exactly one
  // ACTIVE port exists, preselect it so the mandatory assignment costs one
  // less step. Baseline snapshot stays in sync so no false "unsaved changes"
  // prompt appears; manual picks and edits are never overridden.
  React.useEffect(() => {
    if (!dialogOpen || editing || !isPortBoundRole) return;
    if (form.checkpointId && form.checkpointId !== ALL_SENTINEL) return;
    const active = checkpoints.filter((c) => c.status === "ACTIVE");
    if (active.length !== 1) return;
    const next = { ...form, checkpointId: String(active[0].id) };
    setForm(next);
    setSavedJson(JSON.stringify(next));
  }, [dialogOpen, editing, isPortBoundRole, checkpoints, form]);

  const submitUser = () => {
    const next: Record<string, string | undefined> = {};
    if (!form.name.trim() || form.name.trim().length < 2) {
      next.name = "لطفاً نام کامل کاربر را بنویسید.";
    }
    if (!EMAIL_RE.test(form.email.trim())) {
      next.email = "لطفاً ایمیل معتبر وارد نمایید.";
    }
    // Password policy (min 8 chars incl. letters and digits) — required on
    // create, optional on edit (empty = keep current password).
    if (!editing || form.password) {
      const pwErr = passwordError(form.password);
      if (pwErr) next.password = pwErr;
    }
    if (!form.roleId) {
      next.roleId = "لطفاً صلاحیت کاربر را انتخاب کنید.";
    }
    // Port-bound roles MUST have an assigned checkpoint (server-enforced too).
    if (isPortBoundRole && !hasCheckpoint) {
      next.checkpointId = "برای این صلاحیت تخصیص بندر ضروری است";
    }
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    const base: Record<string, unknown> = {
      name: form.name.trim(),
      email: form.email.trim().toLowerCase(),
      roleId: Number(form.roleId),
      checkpointId:
        form.checkpointId === ALL_SENTINEL || form.checkpointId === ""
          ? null
          : Number(form.checkpointId),
      isActive: form.isActive,
    };
    if (!editing || form.password) {
      base.password = form.password;
    }
    saveUser.mutate(base);
  };

  // ---------- admin guard ----------
  if (!isAdmin) {
    return (
      <EmptyState
        icon={<ShieldAlert className="size-12" />}
        title="دسترسی محدود"
        description="شما اجازه دسترسی به این بخش را ندارید."
      />
    );
  }

  return (
    <div>
      <PageHeader
        breadcrumbs={breadcrumbItems("users")}
        title="کاربران سیستم"
        description="ایجاد و مدیریت حساب‌های کاربری سیستم"
        actions={
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-4" />
            کاربر جدید
          </Button>
        }
      />

      <TableShell
        toolbar={
          <TableToolbar
            value={search}
            onChange={setSearch}
            placeholder="جستجوی کاربر به اساس نام، ایمیل یا صلاحیت…"
          />
        }
        footer={
          <TablePagination
            page={paging.page}
            pageCount={paging.pageCount}
            total={paging.total}
            onPage={paging.setPage}
            entityLabel="کاربر"
          />
        }
      >
        {usersQ.isLoading ? (
          <TableSkeleton rows={6} cols={6} />
        ) : usersQ.isError ? (
          // A failed request is NOT an empty list — show the failure with
          // retry instead of "هیچ کاربری ثبت نشده است" (spec §2)
          <EmptyState
            icon={<UserCog className="size-10" />}
            title="بارگذاری فهرست کاربران ناموفق بود"
            description={(usersQ.error as Error)?.message ?? "خطا در ارتباط با سرور؛ لطفاً دوباره تلاش کنید."}
            action={
              <Button size="sm" variant="outline" disabled={usersQ.isFetching} onClick={() => void usersQ.refetch()}>
                <RefreshCw className={cn("size-4", usersQ.isFetching && "animate-spin")} />
                تلاش دوباره
              </Button>
            }
          />
        ) : users.length === 0 ? (
          <EmptyState
            icon={<UserCog className="size-10" />}
            title="هیچ کاربری ثبت نشده است"
            description="برای شروع، یک حساب کاربری جدید ایجاد نمایید."
            action={
              <Button size="sm" onClick={openCreate}>
                <Plus className="size-4" />
                کاربر جدید
              </Button>
            }
          />
        ) : (
          <div className="min-w-[680px]">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-muted">
                <TableRow>
                  <SortHead label="نام" k="name" sort={sort} onSort={toggleSort} />
                  <SortHead
                    label="ایمیل"
                    k="email"
                    sort={sort}
                    onSort={toggleSort}
                    className="hidden md:table-cell"
                  />
                  <SortHead label="صلاحیت" k="role" sort={sort} onSort={toggleSort} />
                  <TableHead>بندر مسئولیت</TableHead>
                  <SortHead label="وضعیت" k="status" sort={sort} onSort={toggleSort} />
                  <TableHead className="hidden md:table-cell">ایجاد شده</TableHead>
                  <TableHead className="no-print">عملیات</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paging.paged.map((row) => {
                  const portBound = PORT_BOUND_ROLES.includes(row.role.name);
                  return (
                    <TableRow key={row.id} className="hover:bg-muted/40">
                      <TableCell className="font-medium align-middle">
                        <span className="block max-w-[14rem] truncate" title={row.name}>
                          {row.name}
                        </span>
                      </TableCell>
                      <TableCell className="align-middle hidden md:table-cell">
                        <div
                          dir="ltr"
                          className="max-w-48 truncate text-right font-mono text-xs"
                          title={row.email}
                        >
                          {row.email}
                        </div>
                      </TableCell>
                      <TableCell className="align-middle">
                        {ROLE_LABELS[row.role.name] ?? row.role.nameDari}
                      </TableCell>
                      <TableCell className="align-middle">
                        {row.checkpoint ? (
                          <Badge variant="outline" className="font-normal gap-1 max-w-[12rem]">
                            <UserCog className="size-3 shrink-0 text-muted-foreground" />
                            <span className="truncate">{row.checkpoint.name}</span>
                          </Badge>
                        ) : portBound ? (
                          <Badge
                            variant="outline"
                            className="bg-warning-soft text-warning border-warning/30 font-normal gap-1"
                            title="این حساب بدون بندر هیچ معلوماتی دریافت نمی‌کند"
                          >
                            — بدون بندر
                          </Badge>
                        ) : (
                          <Badge
                            variant="outline"
                            className="bg-muted text-muted-foreground border-border font-normal"
                            title="حساب مدیر — دسترسی به همه بنادر"
                          >
                            همه بنادر
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="align-middle">
                        <ActiveStatusBadge status={row.isActive ? "ACTIVE" : "INACTIVE"} />
                      </TableCell>
                      <TableCell className="align-middle text-xs text-muted-foreground tabular-nums hidden md:table-cell">
                        {formatJalali(row.createdAt)}
                      </TableCell>
                      <TableCell className="align-middle no-print">
                        <Button
                          variant="outline"
                          size="sm"
                          className="whitespace-nowrap"
                          onClick={() => openEdit(row)}
                          aria-label={`ویرایش کاربر ${row.name}`}
                        >
                          <Pencil className="size-3.5" />
                          ویرایش
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </TableShell>

      {/* ---------- Create / edit user dialog ---------- */}
      <FormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={editing ? "ویرایش کاربر" : "ایجاد کاربر جدید"}
        description={
          editing
            ? `ویرایش معلومات حساب کاربری «${editing.name}»`
            : "معلومات حساب کاربری جدید را وارد نمایید."
        }
        icon={<UserCog className="size-5 text-primary shrink-0" />}
        size="md"
        busy={saveUser.isPending}
        dirty={dirty}
        onSubmit={submitUser}
        submitLabel="ذخیره"
      >
        {/* ۱ — معلومات کاربر */}
        <FormSection title="معلومات کاربر" description="نام، ایمیل و پاسورد حساب کاربری را درج نمایید.">
          <FieldBlock label="نام کامل" htmlFor="user-name" required error={errors.name}>
            <Input
              id="user-name"
              placeholder="مثلاً احمد ولی کریمی"
              value={form.name}
              onChange={(e) => {
                setForm((s) => ({ ...s, name: e.target.value }));
                clearError("name");
              }}
              aria-invalid={!!errors.name}
            />
          </FieldBlock>
          <FieldBlock label="ایمیل" htmlFor="user-email" required error={errors.email}>
            <Input
              id="user-email"
              dir="ltr"
              type="email"
              className="text-left"
              placeholder="user@aogc.gov.af"
              value={form.email}
              onChange={(e) => {
                setForm((s) => ({ ...s, email: e.target.value }));
                clearError("email");
              }}
              aria-invalid={!!errors.email}
            />
          </FieldBlock>
          <FieldBlock
            label={editing ? "پاسورد جدید (اختیاری)" : "پاسورد"}
            htmlFor="user-password"
            required={!editing}
            error={errors.password}
            hint="حداقل ۸ حرف شامل حروف و ارقام"
            span
          >
            <div className="relative">
              <Input
                id="user-password"
                dir="ltr"
                type={showPassword ? "text" : "password"}
                className="text-left pe-10"
                placeholder={editing ? "برای تغییر پاسورد پر کنید" : "••••••••"}
                value={form.password}
                onChange={(e) => {
                  setForm((s) => ({ ...s, password: e.target.value }));
                  clearError("password");
                }}
                autoComplete="new-password"
                aria-invalid={!!errors.password}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute end-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={showPassword ? "پنهان‌کردن پاسورد" : "نمایش پاسورد"}
              >
                {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </FieldBlock>
        </FormSection>

        {/* ۲ — صلاحیت و بندر مسئولیت */}
        <FormSection
          title="صلاحیت و بندر مسئولیت"
          description="صلاحیت دسترسی‌های کاربر و بندر مسئولیت او را تعیین کنید."
        >
          <FieldBlock
            label="صلاحیت"
            htmlFor="user-role"
            required
            error={errors.roleId}
            hint={
              selectedRoleName
                ? (ROLE_DESCRIPTIONS[selectedRoleName] ?? selectedRole?.description ?? undefined)
                : "توضیحات صلاحیت پس از انتخاب نمایش داده می‌شود."
            }
          >
            <SearchSelect
              id="user-role"
              value={form.roleId || null}
              onChange={(v) => {
                setForm((s) => ({ ...s, roleId: v ?? "" }));
                clearError("roleId");
                clearError("checkpointId");
              }}
              options={toOptions(roles, (r) => r.id, (r) => r.nameDari, (r) => r.description)}
              placeholder="انتخاب صلاحیت"
              searchPlaceholder="جستجوی صلاحیت…"
              loading={rolesQ.isLoading}
              invalid={!!errors.roleId}
            />
          </FieldBlock>
          <FieldBlock
            label={
              isPortBoundRole
                ? "بندر مسئولیت * (برای این صلاحیت ضروری است)"
                : "بندر مسئولیت (خالی = دسترسی ملی)"
            }
            htmlFor="user-checkpoint"
            required={isPortBoundRole}
            error={errors.checkpointId}
            hint={
              isPortBoundRole
                ? "کاربر بندربند فقط بندر خودش را دریافت می‌کند."
                : hasCheckpoint
                  ? "کاربر بندربند فقط بندر خودش را دریافت می‌کند."
                  : "بدون بندر = دسترسی ملی (مدیر)."
            }
          >
            <SearchSelect
              id="user-checkpoint"
              value={form.checkpointId || null}
              onChange={(v) => {
                setForm((s) => ({ ...s, checkpointId: isPortBoundRole ? (v ?? "") : (v ?? ALL_SENTINEL) }));
                clearError("checkpointId");
              }}
              options={
                isPortBoundRole
                  ? toOptions(
                      checkpoints.filter((c) => c.status === "ACTIVE"),
                      (c) => c.id,
                      (c) => c.name,
                      (c) => c.province
                    )
                  : [
                      {
                        value: ALL_SENTINEL,
                        label: "همه بنادر (دسترسی ملی)",
                        description: "بدون بندر = دسترسی ملی (مدیر)",
                      },
                      ...toOptions(
                        checkpoints,
                        (c) => c.id,
                        (c) => c.name,
                        (c) => c.province
                      ),
                    ]
              }
              placeholder={isPortBoundRole ? "انتخاب بندر مسئولیت" : "همه بنادر (دسترسی ملی)"}
              searchPlaceholder="جستجوی بندر…"
              loading={checkpointsQ.isLoading}
              allowClear={!isPortBoundRole}
              invalid={!!errors.checkpointId}
            />
          </FieldBlock>
          {isPortBoundRole && !hasCheckpoint && (
            <div className="sm:col-span-2 rounded-lg bg-secondary text-primary p-3 text-xs flex items-start gap-2">
              <Info className="size-4 mt-0.5 shrink-0" />
              <span>حساب‌های بدون بندر (غیرمدیر) هیچ معلوماتی دریافت نمی‌کنند</span>
            </div>
          )}
        </FormSection>

        {/* ۳ — وضعیت حساب */}
        <FormSection
          title="وضعیت حساب"
          description="حساب غیرفعال امکان ورود به سیستم را ندارد."
          columns={1}
        >
          <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 p-3">
            <div className="space-y-1 min-w-0">
              <label className="text-sm font-medium leading-none" htmlFor="user-active">
                وضعیت حساب
              </label>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">حساب فعال</span>
                <ActiveStatusBadge status={form.isActive ? "ACTIVE" : "INACTIVE"} />
              </div>
              <p className="text-xs text-muted-foreground">
                غیرفعال کردن حساب، نشست‌های فعال آن را نیز مسدود می‌کند
              </p>
            </div>
            <Switch
              id="user-active"
              checked={form.isActive}
              onCheckedChange={(v) => setForm((s) => ({ ...s, isActive: v }))}
            />
          </div>
        </FormSection>
      </FormDialog>
    </div>
  );
}

export { UsersView };
export default UsersView;
