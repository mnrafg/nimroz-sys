"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CalendarDays,
  Coins,
  Gauge,
  FileText,
  Fingerprint,
  History,
  Loader2,
  Pencil,
  Plus,
  UserPlus,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, ActiveStatusBadge, JalaliDateInput } from "@/components/shared";
import { PERIOD_LABELS } from "@/lib/constants";
import { ImporterSummaryPanel } from "@/components/biometric/importer-summary-panel";
import { apiFetch } from "@/lib/client-api";
import { newIdempotencyKey } from "@/lib/idempotency";
import { useAppStore } from "@/store/app-store";
import { IMPORTER_TYPE_LABELS } from "@/lib/biometric/types";
import { formatNumber, toPersianDigits } from "@/lib/jalali";
import { cn } from "@/lib/utils";

// ============================================================
// GroupDetailDialog — جزئیات گروپ
//
// Reused from the groups manager AND the importer summary panel.
// Shows the group record, its optional subgroups, its members and a
// simple import summary computed from the EXISTING ImportEntry records
// (no duplicated transaction storage). Only ADMIN sees management
// actions; everything is read-only for officers/supervisors.
// ============================================================

export interface GroupRecord {
  id: number;
  code: string;
  name: string;
  description: string | null;
  mandateDoc: string | null;
  undertakingDoc: string | null;
  status: string;
  representative: { id: number; name: string; importerCode: string } | null;
}

export interface GroupDetailResponse {
  group: GroupRecord;
  /** Group quotas — PER-MEMBER allowances (each active member owns the
   *  full allowedQuantity; the pool multiplies by the member count). */
  sharedQuotas: Array<{
    limitId: number;
    checkpoint: { id: number; name: string };
    periodType: string;
    /** PER-MEMBER allowance. */
    allowedQuantity: number;
    uomSymbol: string;
    restriction: string | null;
    windowLabel: string | null;
    memberCount: number | null;
    totalAllowed: number | null;
    consumed: number;
    remaining: number;
    excess: number;
    usagePercent: number | null;
    byMember: Array<{
      importerId: number;
      name: string;
      importerCode: string;
      entries: number;
      chargedQuantity: number;
      /** This member's personal allowance left. */
      memberRemaining: number;
    }>;
  }>;
  subgroups: Array<{
    id: number;
    code: string;
    name: string;
    status: string;
    _count: { members: number };
  }>;
  members: Array<{
    id: number;
    importerCode: string;
    name: string;
    fatherName: string | null;
    importerType: string;
    membershipStatus: string;
    biometricStatus: string;
    hasPhoto: boolean;
    subgroupId: number | null;
  }>;
  summary: {
    activeMembers: number;
    totalEntries: number;
    petrolLiters: number;
    dieselLiters: number;
    byMember: Array<{
      importerId: number;
      name: string;
      importerCode: string;
      entries: number;
      petrolLiters: number;
      dieselLiters: number;
    }>;
    byDate: Array<{ date: string; entries: number; petrolLiters: number; dieselLiters: number }>;
    window: { from: string; to: string };
  };
}

type SummaryPreset = "7d" | "30d" | "custom";

interface GroupDetailDialogProps {
  groupId: number | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** When true (ADMIN) management actions are offered. */
  isAdmin?: boolean;
  onEditGroup?: (group: GroupRecord) => void;
  /** Called after any subgroup change so parent lists can refresh. */
  onDataChanged?: () => void;
}

export function GroupDetailDialog({
  groupId,
  open,
  onOpenChange,
  isAdmin = false,
  onEditGroup,
  onDataChanged,
}: GroupDetailDialogProps) {
  const queryClient = useQueryClient();
  const [preset, setPreset] = React.useState<SummaryPreset>("30d");
  const [customFrom, setCustomFrom] = React.useState<string | null>(null);
  const [customTo, setCustomTo] = React.useState<string | null>(null);
  const [subgroupDialog, setSubgroupDialog] = React.useState<
    { mode: "create" } | { mode: "edit"; subgroup: GroupDetailResponse["subgroups"][number] } | null
  >(null);
  const [memberSummaryId, setMemberSummaryId] = React.useState<number | null>(null);
  const setImporterIntent = useAppStore((s) => s.setImporterIntent);
  const setView = useAppStore((s) => s.setView);

  /** "Add member": the selected group (and a chosen subgroup) travel into
   *  the importer registration form — the user never re-selects them. */
  const addMember = (subgroupId?: number) => {
    if (groupId === null) return;
    setImporterIntent({ groupId, subgroupId });
    setView("importers");
    onOpenChange(false);
  };

  React.useEffect(() => {
    if (open) {
      setPreset("30d");
      setCustomFrom(null);
      setCustomTo(null);
    }
  }, [open, groupId]);

  const window = React.useMemo(() => {
    const now = new Date();
    const day = 24 * 60 * 60 * 1000;
    if (preset === "7d") {
      return { from: new Date(now.getTime() - 6 * day).toISOString(), to: now.toISOString() };
    }
    if (preset === "custom") {
      return {
        from: customFrom ? new Date(customFrom).toISOString() : new Date(now.getTime() - 29 * day).toISOString(),
        to: customTo ? new Date(customTo).toISOString() : now.toISOString(),
      };
    }
    return { from: new Date(now.getTime() - 29 * day).toISOString(), to: now.toISOString() };
  }, [preset, customFrom, customTo]);

  const detail = useQuery({
    queryKey: ["importer-group", groupId, window.from, window.to],
    queryFn: () =>
      apiFetch<GroupDetailResponse>(
        `/api/importer-groups/${groupId}?from=${window.from}&to=${window.to}`
      ),
    enabled: open && groupId !== null,
  });

  const group = detail.data?.group;
  const summary = detail.data?.summary;
  const subgroups = detail.data?.subgroups ?? [];
  const members = detail.data?.members ?? [];

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-3xl max-h-[92vh] overflow-hidden flex flex-col" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="size-5 text-primary" />
              {group ? `گروپ: ${group.name}` : "جزئیات گروپ"}
              {group && (
                <Badge variant="outline" className="bg-muted/60 text-[10px] font-mono" dir="ltr">
                  {group.code}
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription>
              اعضا، زیرگروپ‌ها و خلاصه واردات — همه ارقام از ثبت‌های موجود محاسبه می‌شود و سهمیه فردی را تغییر نمی‌دهد.
            </DialogDescription>
          </DialogHeader>

          {detail.isLoading ? (
            <div className="flex items-center justify-center py-14 gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-5 animate-spin" /> در حال بارگذاری…
            </div>
          ) : detail.isError ? (
            <div className="rounded-md border border-danger/30 bg-danger-soft text-danger text-sm p-3">
              {(detail.error as Error).message}
            </div>
          ) : group ? (
            <div className="space-y-4 overflow-y-auto pe-1">
              {/* ---- Group record ---- */}
              <div className="rounded-xl border bg-card p-4 space-y-2.5">
                <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-2.5 text-sm">
                  <InfoRow label="نام گروپ" value={group.name} strong />
                  <InfoRow label="کود گروپ" value={group.code} mono />
                  <InfoRow
                    label="نماینده مسئول"
                    value={group.representative ? `${group.representative.name} (${group.representative.importerCode})` : "— تعیین نشده —"}
                  />
                  <InfoRow label="وضعیت گروپ" value={group.status === "ACTIVE" ? "فعال" : "غیرفعال"} />
                  <InfoRow label="سند تفویض وکالت" value={group.mandateDoc ?? "—"} />
                  <InfoRow label="تعهدنامه نماینده" value={group.undertakingDoc ?? "—"} />
                </div>
                {group.description && (
                  <div className="text-xs text-muted-foreground flex items-start gap-1.5 border-t pt-2">
                    <FileText className="size-3.5 mt-0.5 shrink-0" />
                    {group.description}
                  </div>
                )}
                {isAdmin && onEditGroup && (
                  <div className="border-t pt-2.5">
                    <Button variant="outline" size="sm" className="gap-1.5 h-8" onClick={() => onEditGroup(group)}>
                      <Pencil className="size-3.5" />
                      ویرایش گروپ
                    </Button>
                  </div>
                )}
              </div>

              {/* ---- GROUP QUOTAS — PER-MEMBER allowances ---- */}
              {(detail.data?.sharedQuotas ?? []).length > 0 && (
                <div className="rounded-xl border bg-card p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <Gauge className="size-4 text-primary" />
                    <h3 className="text-sm font-semibold">حد مجاز گروپ (سهم هر عضو)</h3>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    حد مجاز برای هر عضو جداگانه اعمال می‌شود — هر عضو تا مقدار تعیین‌شده می‌تواند واردات کند؛ مجموع موجودی گروپ = حد هر عضو × تعداد اعضای فعال.
                  </p>
                  {detail.data!.sharedQuotas.map((sq) => (
                    <div key={sq.limitId} className="rounded-lg border bg-muted/30 p-3 space-y-2">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                        <Badge variant="outline" className="bg-muted/60">{sq.checkpoint.name}</Badge>
                        <Badge variant="outline" className="border-gold/60 text-primary bg-gold/10">
                          {PERIOD_LABELS[sq.periodType] ?? sq.periodType}
                        </Badge>
                        {sq.restriction && (
                          <span className="text-[10px] text-muted-foreground">فقط: {sq.restriction}</span>
                        )}
                        {sq.windowLabel && <span className="text-muted-foreground">{sq.windowLabel}</span>}
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                        <StatCard label="حد هر عضو" value={`${formatNumber(sq.allowedQuantity)} ${sq.uomSymbol}`} />
                        <StatCard
                          label="اعضای فعال"
                          value={sq.memberCount != null ? toPersianDigits(sq.memberCount) : "—"}
                        />
                        <StatCard
                          label="مجموع موجودی گروپ"
                          value={sq.totalAllowed != null ? `${formatNumber(sq.totalAllowed)} ${sq.uomSymbol}` : "—"}
                        />
                        <StatCard label="مصرف‌شده (مجموع)" value={`${formatNumber(sq.consumed)} ${sq.uomSymbol}`} />
                        <StatCard
                          label="باقی‌مانده (مجموع)"
                          value={`${formatNumber(sq.remaining)} ${sq.uomSymbol}`}
                        />
                      </div>
                      {sq.excess > 0 && (
                        <div className="text-xs text-danger">مقدار اضافی مصرف‌شده: {formatNumber(sq.excess)} {sq.uomSymbol}</div>
                      )}
                      {sq.byMember.length > 0 && (
                        <div>
                          <div className="text-[11px] font-medium text-muted-foreground mb-1">مصرف و سهم باقی‌مانده هر عضو</div>
                          <div className="rounded-md border overflow-hidden">
                            <div className="overflow-x-auto max-h-32 overflow-y-auto">
                              <Table>
                                <TableHeader className="sticky top-0 bg-muted z-10">
                                  <TableRow>
                                    <TableHead>نمبر</TableHead>
                                    <TableHead>عضو</TableHead>
                                    <TableHead className="text-center">ثبت‌ها</TableHead>
                                    <TableHead className="text-center">مقدار مصرف</TableHead>
                                    <TableHead className="text-center">سهم باقی‌مانده عضو</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {sq.byMember.map((m) => (
                                    <TableRow key={m.importerId}>
                                      <TableCell className="font-mono text-xs">{m.importerCode}</TableCell>
                                      <TableCell className="text-xs">{m.name}</TableCell>
                                      <TableCell className="text-center text-xs">{toPersianDigits(m.entries)}</TableCell>
                                      <TableCell className="text-center text-xs">
                                        {formatNumber(m.chargedQuantity)} {sq.uomSymbol}
                                      </TableCell>
                                      <TableCell
                                        className={
                                          "text-center text-xs font-medium " +
                                          (m.memberRemaining <= 0 ? "text-danger" : "text-success")
                                        }
                                      >
                                        {formatNumber(m.memberRemaining)} {sq.uomSymbol}
                                      </TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* ---- Summary stats ---- */}
              <div className="rounded-xl border bg-card p-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
                  <div className="flex items-center gap-2">
                    <History className="size-4 text-primary" />
                    <h3 className="text-sm font-semibold">خلاصه واردات گروپ</h3>
                  </div>
                  <Tabs value={preset} onValueChange={(v) => setPreset(v as SummaryPreset)}>
                    <TabsList className="h-8">
                      <TabsTrigger value="7d" className="text-xs h-7 px-2.5">۷ روز</TabsTrigger>
                      <TabsTrigger value="30d" className="text-xs h-7 px-2.5">۳۰ روز</TabsTrigger>
                      <TabsTrigger value="custom" className="text-xs h-7 px-2.5 gap-1">
                        <CalendarDays className="size-3" /> بازه مشخص
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                </div>
                {preset === "custom" && (
                  <div className="grid grid-cols-2 gap-2 mb-3 max-w-xs">
                    <JalaliDateInput value={customFrom} onChange={setCustomFrom} placeholder="از تاریخ" />
                    <JalaliDateInput value={customTo} onChange={setCustomTo} placeholder="تا تاریخ" />
                  </div>
                )}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <StatCard label="اعضای فعال" value={toPersianDigits(summary?.activeMembers ?? 0)} />
                  <StatCard label="ثبت‌های تأییدشده" value={toPersianDigits(summary?.totalEntries ?? 0)} />
                  <StatCard label="پطرول واردشده (لیتر)" value={formatNumber(summary?.petrolLiters ?? 0)} icon={Coins} />
                  <StatCard label="دیزل واردشده (لیتر)" value={formatNumber(summary?.dieselLiters ?? 0)} icon={Coins} />
                </div>

                {/* By member */}
                <div className="mt-4">
                  <div className="text-xs font-medium text-muted-foreground mb-1.5">واردات بر اساس عضو</div>
                  {!summary?.byMember.length ? (
                    <div className="text-xs text-muted-foreground">در این بازه وارداتی ثبت نشده است.</div>
                  ) : (
                    <div className="rounded-md border overflow-hidden">
                      <div className="overflow-x-auto max-h-40 overflow-y-auto">
                        <Table>
                          <TableHeader className="sticky top-0 bg-muted z-10">
                            <TableRow>
                              <TableHead>نمبر</TableHead>
                              <TableHead>عضو</TableHead>
                              <TableHead className="text-center">ثبت‌ها</TableHead>
                              <TableHead className="text-center">پطرول (لیتر)</TableHead>
                              <TableHead className="text-center">دیزل (لیتر)</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {summary.byMember.map((m) => (
                              <TableRow key={m.importerId}>
                                <TableCell className="font-mono text-xs">{m.importerCode}</TableCell>
                                <TableCell className="text-xs">{m.name}</TableCell>
                                <TableCell className="text-center text-xs">{toPersianDigits(m.entries)}</TableCell>
                                <TableCell className="text-center text-xs">{formatNumber(m.petrolLiters)}</TableCell>
                                <TableCell className="text-center text-xs">{formatNumber(m.dieselLiters)}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  )}
                </div>

                {/* By date */}
                <div className="mt-3">
                  <div className="text-xs font-medium text-muted-foreground mb-1.5">واردات بر اساس تاریخ</div>
                  {!summary?.byDate.length ? (
                    <div className="text-xs text-muted-foreground">در این بازه وارداتی ثبت نشده است.</div>
                  ) : (
                    <div className="rounded-md border overflow-hidden">
                      <div className="overflow-x-auto max-h-40 overflow-y-auto">
                        <Table>
                          <TableHeader className="sticky top-0 bg-muted z-10">
                            <TableRow>
                              <TableHead>تاریخ</TableHead>
                              <TableHead className="text-center">ثبت‌ها</TableHead>
                              <TableHead className="text-center">پطرول (لیتر)</TableHead>
                              <TableHead className="text-center">دیزل (لیتر)</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {summary.byDate.slice(0, 31).map((d) => (
                              <TableRow key={d.date}>
                                <TableCell className="text-xs">{d.date}</TableCell>
                                <TableCell className="text-center text-xs">{toPersianDigits(d.entries)}</TableCell>
                                <TableCell className="text-center text-xs">{formatNumber(d.petrolLiters)}</TableCell>
                                <TableCell className="text-center text-xs">{formatNumber(d.dieselLiters)}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* ---- Subgroups (optional, simple) ---- */}
              <div className="rounded-xl border bg-card p-4">
                <div className="flex items-center justify-between gap-2 mb-3">
                  <div className="flex items-center gap-2">
                    <Users className="size-4 text-primary" />
                    <h3 className="text-sm font-semibold">زیرگروپ‌ها</h3>
                    <span className="text-xs text-muted-foreground">({toPersianDigits(subgroups.length)})</span>
                  </div>
                  {isAdmin && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 h-8"
                      onClick={() => setSubgroupDialog({ mode: "create" })}
                    >
                      <Plus className="size-3.5" />
                      افزودن زیرگروپ
                    </Button>
                  )}
                </div>
                {!subgroups.length ? (
                  <div className="text-xs text-muted-foreground">زیرگروپی برای این گروپ ثبت نشده است (اختیاری).</div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {subgroups.map((s) => (
                      <div key={s.id} className="rounded-lg border p-2.5 flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-sm font-medium truncate">{s.name}</div>
                          <div className="text-[11px] text-muted-foreground font-mono" dir="ltr">{s.code}</div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                            {toPersianDigits(s._count.members)} عضو
                          </span>
                          <ActiveStatusBadge status={s.status} />
                          {isAdmin && (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7"
                                title="افزودن عضو به این زیرگروپ"
                                onClick={() => addMember(s.id)}
                              >
                                <UserPlus className="size-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7"
                                title="ویرایش زیرگروپ"
                                onClick={() => setSubgroupDialog({ mode: "edit", subgroup: s })}
                              >
                                <Pencil className="size-3.5" />
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* ---- Members ---- */}
              <div className="rounded-xl border bg-card p-4">
                <div className="flex items-center justify-between gap-2 mb-3">
                  <div className="flex items-center gap-2">
                    <Users className="size-4 text-primary" />
                    <h3 className="text-sm font-semibold">اعضای گروپ</h3>
                    <span className="text-xs text-muted-foreground">({toPersianDigits(members.length)} عضو)</span>
                  </div>
                  {isAdmin && (
                    <Button variant="outline" size="sm" className="gap-1.5 h-8" onClick={() => addMember()}>
                      <UserPlus className="size-3.5" />
                      افزودن عضو
                    </Button>
                  )}
                </div>
                {!members.length ? (
                  <EmptyState
                    icon={<Users className="size-8" />}
                    title="هیچ عضوی ثبت نشده"
                    description="کارگران مرزنشین از طریق فرم ثبت واردکننده به این گروپ تخصیص می‌شوند."
                    action={
                      isAdmin ? (
                        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => addMember()}>
                          <UserPlus className="size-3.5" />
                          افزودن عضو به این گروپ
                        </Button>
                      ) : undefined
                    }
                  />
                ) : (
                  <div className="rounded-md border overflow-hidden">
                    <div className="overflow-x-auto max-h-56 overflow-y-auto">
                      <Table>
                        <TableHeader className="sticky top-0 bg-muted z-10">
                          <TableRow>
                            <TableHead>نمبر</TableHead>
                            <TableHead>نام</TableHead>
                            <TableHead>نوع</TableHead>
                            <TableHead>زیرگروپ</TableHead>
                            <TableHead>عضویت</TableHead>
                            <TableHead className="text-center">بایومتریک</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {members.map((m) => (
                            <TableRow
                              key={m.id}
                              className="hover:bg-muted/40 cursor-pointer"
                              onClick={() => setMemberSummaryId(m.id)}
                              title="مشاهده پروفایل عضو"
                            >
                              <TableCell className="font-mono text-xs">{m.importerCode}</TableCell>
                              <TableCell className="text-xs font-medium">{m.name}</TableCell>
                              <TableCell className="text-xs">{IMPORTER_TYPE_LABELS[m.importerType] ?? m.importerType}</TableCell>
                              <TableCell className="text-xs">
                                {subgroups.find((s) => s.id === m.subgroupId)?.name ?? "—"}
                              </TableCell>
                              <TableCell>
                                <ActiveStatusBadge status={m.membershipStatus} />
                              </TableCell>
                              <TableCell className="text-center">
                                {m.biometricStatus === "ENROLLED" ? (
                                  <Fingerprint className="size-4 text-success inline" />
                                ) : (
                                  <Fingerprint className="size-4 text-muted-foreground/40 inline" />
                                )}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Subgroup create / edit dialog */}
      {subgroupDialog && groupId !== null && (
        <SubgroupFormDialog
          open={true}
          onOpenChange={(v) => !v && setSubgroupDialog(null)}
          groupId={groupId}
          subgroup={subgroupDialog.mode === "edit" ? subgroupDialog.subgroup : null}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: ["importer-group", groupId] });
            queryClient.invalidateQueries({ queryKey: ["importer-groups"] });
            onDataChanged?.();
          }}
        />
      )}

      {/* Member profile (reuse the existing importer summary panel) —
          mounted only when requested (avoids closed-dialog recursion). */}
      {memberSummaryId !== null && (
        <ImporterSummaryPanel
          importerId={memberSummaryId}
          open={true}
          onOpenChange={(v) => !v && setMemberSummaryId(null)}
        />
      )}
    </>
  );
}

export function SubgroupFormDialog({
  open,
  onOpenChange,
  groupId,
  subgroup,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  groupId: number;
  subgroup: { id: number; code: string; name: string; status: string } | null;
  onSaved?: () => void;
}) {
  const [name, setName] = React.useState(subgroup?.name ?? "");
  const [status, setStatus] = React.useState(subgroup?.status ?? "ACTIVE");
  const [error, setError] = React.useState<string | null>(null);
  // Parent group is LOCKED by the URL — the code inherits it (GRP-XX-Sn)
  // and is allocated server-side.
  const idemKeyRef = React.useRef<string>(newIdempotencyKey());

  React.useEffect(() => {
    if (open) {
      if (!subgroup) idemKeyRef.current = newIdempotencyKey();
      setName(subgroup?.name ?? "");
      setStatus(subgroup?.status ?? "ACTIVE");
      setError(null);
    }
  }, [open, subgroup]);

  const save = useMutation({
    mutationFn: () => {
      if (subgroup) {
        return apiFetch(`/api/importer-subgroups/${subgroup.id}`, {
          method: "PUT",
          body: JSON.stringify({ name, status }),
        });
      }
      return apiFetch(`/api/importer-groups/${groupId}/subgroups`, {
        method: "POST",
        body: JSON.stringify({ name, status, idempotencyKey: idemKeyRef.current }),
      });
    },
    onSuccess: () => {
      toast.success(subgroup ? "زیرگروپ ویرایش شد." : "زیرگروپ جدید ثبت شد.");
      onSaved?.();
      onOpenChange(false);
    },
    onError: (e: Error) => setError(e.message),
  });

  const submit = () => {
    if (name.trim().length < 2) return setError("لطفاً نام زیرگروپ را بنویسید.");
    setError(null);
    save.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" dir="rtl">
        <DialogHeader>
          <DialogTitle>{subgroup ? "ویرایش زیرگروپ" : "افزودن زیرگروپ"}</DialogTitle>
          <DialogDescription>
            زیرگروپ اختیاری است و مسئولیت همچنان با نماینده مسئول گروپ می‌باشد.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="sub-name">نام زیرگروپ *</Label>
            <Input
              id="sub-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="نام زیرگروپ"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sub-status">وضعیت</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger id="sub-status"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ACTIVE">فعال</SelectItem>
                <SelectItem value="INACTIVE">غیرفعال</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {error && <div className="text-xs text-destructive">{error}</div>}
        </div>
        <DialogFooter className="flex-row justify-start gap-2">
          <Button onClick={submit} disabled={save.isPending}>
            {save.isPending ? "در حال ذخیره..." : "ذخیره"}
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>لغو</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InfoRow({ label, value, strong, mono }: { label: string; value: string; strong?: boolean; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={cn("truncate", strong && "font-semibold", mono && "font-mono text-xs")} title={value}>
        {value}
      </div>
    </div>
  );
}

function StatCard({ label, value, icon: Icon }: { label: string; value: string; icon?: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="rounded-lg border bg-muted/30 px-2.5 py-2">
      <div className="text-[10px] text-muted-foreground truncate flex items-center gap-1">
        {Icon && <Icon className="size-3" />}
        {label}
      </div>
      <div className="text-sm font-bold truncate">{value}</div>
    </div>
  );
}
