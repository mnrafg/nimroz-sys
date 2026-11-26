"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BadgeCheck, FileText, IdCard, Pencil, Plus, Search, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { EmptyState, ActiveStatusBadge, FieldError, TablePagination, TableToolbar, usePagedRows } from "@/components/shared";
import { SearchSelect, toOptions } from "@/components/ui/search-select";
import { GroupDetailDialog, type GroupRecord } from "@/components/importer-groups/group-detail-dialog";
import { IdCardDialog } from "@/components/biometric/id-card-dialog";
import { apiFetch } from "@/lib/client-api";
import { toPersianDigits } from "@/lib/jalali";
import { newIdempotencyKey } from "@/lib/idempotency";

// ============================================================
// GroupsManager — مدیریت گروپ‌ها (tab inside the واردکنندگان module)
//
// ADMIN-only management of importer groups per the border-import
// regulation: create/edit groups, assign an official representative
// (an EXISTING registered importer — referenced by FK, personal data
// is never duplicated), view members, manage optional subgroups and
// activate/deactivate groups. Printing the کارت نماینده گروپ reuses
// the existing ID-card template.
// ============================================================

interface GroupRow extends GroupRecord {
  _count: { members: number; subgroups: number };
}

interface GroupForm {
  code: string;
  name: string;
  representativeId: string | null;
  description: string;
  mandateDoc: string;
  undertakingDoc: string;
  status: "ACTIVE" | "INACTIVE";
}

const EMPTY_GROUP_FORM: GroupForm = {
  code: "",
  name: "",
  representativeId: null,
  description: "",
  mandateDoc: "",
  undertakingDoc: "",
  status: "ACTIVE",
};

export function GroupsManager() {
  const queryClient = useQueryClient();
  const [q, setQ] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("all");
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<GroupRow | null>(null);
  const [form, setForm] = React.useState<GroupForm>(EMPTY_GROUP_FORM);
  const [errors, setErrors] = React.useState<Record<string, string | undefined>>({});
  const [detailId, setDetailId] = React.useState<number | null>(null);
  const [repCard, setRepCard] = React.useState<{ importerId: number; groupCode: string; groupName: string } | null>(null);
  /** Idempotency key per create-dialog session. */
  const idemKeyRef = React.useRef<string>(newIdempotencyKey());

  const groups = useQuery({
    queryKey: ["importer-groups", statusFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      return apiFetch<{ groups: GroupRow[] }>(`/api/importer-groups?${params.toString()}`);
    },
  });

  // Registered importers — the representative MUST be an existing importer.
  const importers = useQuery({
    queryKey: ["importers", "", "ACTIVE"],
    queryFn: () =>
      apiFetch<{
        importers: { id: number; name: string; importerCode: string; status: string }[];
      }>("/api/importers?status=ACTIVE"),
    staleTime: 60_000,
  });

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name: form.name,
        representativeId: form.representativeId ? Number(form.representativeId) : null,
        description: form.description || null,
        mandateDoc: form.mandateDoc || null,
        undertakingDoc: form.undertakingDoc || null,
        status: form.status,
        // Retrying the same create request replays the same group.
        ...(editing ? {} : { idempotencyKey: idemKeyRef.current }),
      };
      if (editing) {
        return apiFetch(`/api/importer-groups/${editing.id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
      }
      return apiFetch("/api/importer-groups", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      toast.success(editing ? "معلومات گروپ ویرایش شد." : "گروپ جدید ثبت شد.");
      queryClient.invalidateQueries({ queryKey: ["importer-groups"] });
      queryClient.invalidateQueries({ queryKey: ["importer-group"] });
      setDialogOpen(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const openCreate = () => {
    setEditing(null);
    idemKeyRef.current = newIdempotencyKey();
    setForm(EMPTY_GROUP_FORM);
    setErrors({});
    setDialogOpen(true);
  };

  const openEdit = (row: GroupRow) => {
    setEditing(row);
    setForm({
      code: row.code,
      name: row.name,
      representativeId: row.representative ? String(row.representative.id) : null,
      description: row.description ?? "",
      mandateDoc: row.mandateDoc ?? "",
      undertakingDoc: row.undertakingDoc ?? "",
      status: row.status === "INACTIVE" ? "INACTIVE" : "ACTIVE",
    });
    setErrors({});
    setDialogOpen(true);
  };

  const submit = () => {
    const next: Record<string, string | undefined> = {};
    // Group code is SYSTEM-GENERATED — never required from the user.
    if (form.name.trim().length < 2) next.name = "لطفاً نام گروپ را بنویسید.";
    if (!form.representativeId) next.representativeId = "لطفاً نماینده مسئول گروپ را انتخاب کنید.";
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    save.mutate();
  };

  const filtered = React.useMemo(() => {
    const rows = groups.data?.groups ?? [];
    if (!q.trim()) return rows;
    const needle = q.trim();
    return rows.filter(
      (r) =>
        r.name.includes(needle) ||
        r.code.includes(needle) ||
        (r.representative?.name ?? "").includes(needle) ||
        (r.representative?.importerCode ?? "").includes(needle)
    );
  }, [groups.data, q]);

  const paging = usePagedRows(filtered, 12);

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
        <p className="text-sm text-muted-foreground">
          ایجاد گروپ‌های مرزنشین، تعیین نماینده مسئول، زیرگروپ‌ها و مشاهده اعضا — فقط مدیر سیستم.
        </p>
        <Button onClick={openCreate} className="shrink-0">
          <Plus className="size-4" />
          گروپ جدید
        </Button>
      </div>

      <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
        <div className="p-3 sm:p-4">
          <TableToolbar
            value={q}
            onChange={setQ}
            placeholder="جستجو بر اساس نام گروپ، کود یا نماینده..."
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
          </TableToolbar>
          {groups.isLoading ? (
            <div className="p-6 space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-10 rounded-md bg-muted animate-pulse" />
              ))}
            </div>
          ) : !filtered.length ? (
            <EmptyState
              icon={<Users className="size-10" />}
              title="هیچ گروپی یافت نشد"
              description="گروپ جدید اضافه کنید یا جستجو را تغییر دهید."
            />
          ) : (
            <>
              <div className="overflow-x-auto max-h-[65vh] overflow-y-auto rounded-md border">
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-muted">
                    <TableRow>
                      <TableHead>کود گروپ</TableHead>
                      <TableHead>نام گروپ</TableHead>
                      <TableHead>نماینده مسئول</TableHead>
                      <TableHead className="text-center">اعضای فعال</TableHead>
                      <TableHead className="text-center">زیرگروپ‌ها</TableHead>
                      <TableHead>وضعیت</TableHead>
                      <TableHead className="no-print">عملیات</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paging.paged.map((row) => (
                      <TableRow key={row.id} className="hover:bg-muted/40">
                        <TableCell className="font-mono text-xs" dir="ltr">{row.code}</TableCell>
                        <TableCell className="font-medium">
                          <span className="block max-w-44 truncate" title={row.name}>{row.name}</span>
                        </TableCell>
                        <TableCell className="text-xs">
                          {row.representative ? (
                            <div className="min-w-0">
                              <div className="truncate max-w-40" title={row.representative.name}>
                                {row.representative.name}
                              </div>
                              <div className="text-[10px] text-muted-foreground font-mono" dir="ltr">
                                {row.representative.importerCode}
                              </div>
                            </div>
                          ) : (
                            <span className="text-muted-foreground">— تعیین نشده —</span>
                          )}
                        </TableCell>
                        <TableCell className="text-center">{toPersianDigits(row._count.members)}</TableCell>
                        <TableCell className="text-center">{toPersianDigits(row._count.subgroups)}</TableCell>
                        <TableCell>
                          <ActiveStatusBadge status={row.status} />
                        </TableCell>
                        <TableCell className="no-print">
                          <div className="flex items-center gap-0.5">
                            <Button
                              variant="ghost"
                              size="icon"
                              title="مشاهده اعضا و خلاصه گروپ"
                              onClick={() => setDetailId(row.id)}
                            >
                              <Search className="size-4" />
                            </Button>
                            {row.representative && (
                              <Button
                                variant="ghost"
                                size="icon"
                                title="چاپ کارت نماینده گروپ"
                                onClick={() =>
                                  setRepCard({
                                    importerId: row.representative!.id,
                                    groupCode: row.code,
                                    groupName: row.name,
                                  })
                                }
                              >
                                <IdCard className="size-4" />
                              </Button>
                            )}
                            <Button variant="ghost" size="icon" title="ویرایش گروپ" onClick={() => openEdit(row)}>
                              <Pencil className="size-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <TablePagination
                page={paging.page}
                pageCount={paging.pageCount}
                total={paging.total}
                onPage={paging.setPage}
                entityLabel="گروپ"
              />
            </>
          )}
        </div>
      </div>

      {/* Create / edit group dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[92vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="size-5 text-primary" />
              {editing ? "ویرایش گروپ" : "ثبت گروپ جدید"}
            </DialogTitle>
            <DialogDescription>
              نماینده مسئول باید یک واردکننده ثبت‌شده موجود باشد؛ معلومات شخصی او تکرار نمی‌شود.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2 min-w-0">
            <div className="space-y-1.5 min-w-0">
              <Label htmlFor="grp-name">نام گروپ *</Label>
              <Input
                id="grp-name"
                value={form.name}
                onChange={(e) => {
                  setForm({ ...form, name: e.target.value });
                  setErrors((p) => ({ ...p, name: undefined }));
                }}
                placeholder="گروپ کارگران مرزنشین ..."
                aria-invalid={!!errors.name}
              />
              {errors.name && <FieldError message={errors.name} />}
            </div>
            <div className="space-y-1.5 min-w-0 sm:col-span-2">
              <Label>نماینده مسئول گروپ *</Label>
              <SearchSelect
                value={form.representativeId}
                onChange={(v) => {
                  setForm((f) => ({ ...f, representativeId: v }));
                  setErrors((p) => ({ ...p, representativeId: undefined }));
                }}
                options={toOptions(
                  importers.data?.importers,
                  (i) => String(i.id),
                  (i) => i.name,
                  (i) => i.importerCode,
                  (i) => i.importerCode
                )}
                placeholder="انتخاب واردکننده ثبت‌شده…"
                searchPlaceholder="جستجوی نام یا نمبر واردکننده…"
                loading={importers.isLoading}
                allowClear
                invalid={!!errors.representativeId}
                aria-label="انتخاب نماینده مسئول گروپ"
              />
              {errors.representativeId && <FieldError message={errors.representativeId} />}
              <p className="text-[10px] text-muted-foreground">
                از واردکنندگان فعال ثبت‌شده انتخاب می‌شود؛ نام، نمبر و معلومات تماس او به‌صورت خودکار از رکورد موجود بازیافت می‌شود.
              </p>
            </div>
            <div className="space-y-1.5 min-w-0">
              <Label htmlFor="grp-mandate">سند تفویض وکالت (اختیاری)</Label>
              <Input
                id="grp-mandate"
                value={form.mandateDoc}
                onChange={(e) => setForm({ ...form, mandateDoc: e.target.value })}
                placeholder="شماره/مشخصات سند"
              />
            </div>
            <div className="space-y-1.5 min-w-0">
              <Label htmlFor="grp-undertaking">تعهدنامه نماینده (اختیاری)</Label>
              <Input
                id="grp-undertaking"
                value={form.undertakingDoc}
                onChange={(e) => setForm({ ...form, undertakingDoc: e.target.value })}
                placeholder="شماره/مشخصات تعهدنامه"
              />
            </div>
            <div className="space-y-1.5 min-w-0">
              <Label htmlFor="grp-status">وضعیت</Label>
              <Select
                value={form.status}
                onValueChange={(v) => setForm({ ...form, status: v as "ACTIVE" | "INACTIVE" })}
              >
                <SelectTrigger id="grp-status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ACTIVE">فعال</SelectItem>
                  <SelectItem value="INACTIVE">غیرفعال</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 min-w-0 sm:col-span-2">
              <Label htmlFor="grp-desc">توضیحات (اختیاری)</Label>
              <Textarea
                id="grp-desc"
                rows={2}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter className="flex-row justify-start gap-2">
            <Button onClick={submit} disabled={save.isPending}>
              {save.isPending ? "در حال ذخیره..." : "ذخیره"}
            </Button>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>لغو</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Group details (members, subgroups, import summary) */}
      <GroupDetailDialog
        groupId={detailId}
        open={detailId !== null}
        onOpenChange={(v) => !v && setDetailId(null)}
        isAdmin={true}
        onEditGroup={(g) => {
          const row = groups.data?.groups.find((x) => x.id === g.id);
          if (row) {
            setDetailId(null);
            openEdit(row);
          }
        }}
        onDataChanged={() => queryClient.invalidateQueries({ queryKey: ["importer-groups"] })}
      />

      {/* Representative card (کارت نماینده گروپ) — existing card template */}
      <IdCardDialog
        open={repCard !== null}
        onOpenChange={(v) => !v && setRepCard(null)}
        importer={repCard ? { id: repCard.importerId } : null}
        variant="representative"
        groupForCard={repCard ? { code: repCard.groupCode, name: repCard.groupName } : null}
      />
    </div>
  );
}
