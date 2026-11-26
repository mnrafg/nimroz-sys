"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronsLeft,
  ChevronsRight,
  FilePlus2,
  FileText,
  Gauge,
  LogOut,
  Menu,
  Search,
  Truck,
  Users,
  X,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { BrandLogo } from "@/components/brand";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/client-api";
import { useAppStore, type ViewKey } from "@/store/app-store";
import { formatJalaliDateTime, toJalali, toPersianDigits } from "@/lib/jalali";
import { APP_NAME } from "@/lib/constants";
import { ALL_NAV_CHILDREN, NAV_ITEMS, breadcrumbItems, type NavChild, type NavNode } from "@/lib/nav";

// ============================================================
// Resolved nav node (role-filtered)
// ============================================================

type ResolvedNode =
  | { kind: "single"; key: string; label: string; icon: NavNode["icon"]; view: ViewKey }
  | { kind: "section"; key: string; label: string; icon: NavNode["icon"]; children: NavChild[] };

// ============================================================
// Quick actions (اقدامات سریع) — top navbar, role-gated
// ============================================================

interface QuickAction {
  key: "importer" | "entry" | "limit";
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  roles: string[];
  description: string;
}

const QUICK_ACTIONS: QuickAction[] = [
  {
    key: "entry",
    label: "ثبت واردات",
    icon: FilePlus2,
    roles: ["ADMIN", "OFFICER"],
    description: "ثبت نهایی واردات در بندر",
  },
  {
    key: "importer",
    label: "ثبت واردکننده",
    icon: Truck,
    roles: ["ADMIN", "OFFICER"],
    description: "ثبت واردکننده جدید",
  },
  {
    key: "limit",
    label: "تعیین حد مجاز",
    icon: Gauge,
    roles: ["ADMIN"],
    description: "تعیین حد مجاز واردات",
  },
];

const QUICK_ACTION_TARGETS: Record<QuickAction["key"], ViewKey> = {
  importer: "importers",
  entry: "entries",
  limit: "limits",
};

// ============================================================
// Sidebar navigation — single buttons + accordion sections
// ============================================================

function SidebarNav({
  current,
  onNavigate,
  collapsed = false,
}: {
  current: ViewKey;
  onNavigate: (v: ViewKey) => void;
  collapsed?: boolean;
}) {
  const user = useAppStore((s) => s.user);
  const role = user?.role ?? "";

  const nodes = React.useMemo<ResolvedNode[]>(() => {
    const out: ResolvedNode[] = [];
    for (const node of NAV_ITEMS) {
      if (!node.roles.includes(role)) continue;
      if (node.view) {
        out.push({ kind: "single", key: node.key, label: node.label, icon: node.icon, view: node.view });
      } else {
        const children = (node.children ?? []).filter((c) => c.roles.includes(role));
        if (children.length > 0) {
          out.push({ kind: "section", key: node.key, label: node.label, icon: node.icon, children });
        }
      }
    }
    return out;
  }, [role]);

  // Accordion behavior: only ONE section may be expanded at a time.
  const [openSection, setOpenSection] = React.useState<string | null>(() => {
    const section = NAV_ITEMS.find(
      (n) => !n.view && (n.children ?? []).some((c) => c.key === current)
    );
    return section?.key ?? null;
  });

  // Follow the active page: open its section, or close all accordions on single-button pages.
  React.useEffect(() => {
    const section = NAV_ITEMS.find(
      (n) => !n.view && (n.children ?? []).some((c) => c.key === current)
    );
    setOpenSection(section?.key ?? null);
  }, [current]);

  const toggleSection = (key: string) => {
    setOpenSection((prev) => (prev === key ? null : key));
  };

  if (collapsed) {
    // Icon rail with tooltips — single buttons navigate directly, sections open their first child.
    return (
      <TooltipProvider delayDuration={200}>
        <nav
          aria-label="منوی اصلی سیستم"
          className="flex flex-col gap-1 px-2 py-3 flex-1 overflow-y-auto overflow-x-hidden"
        >
          {nodes.map((node) => {
            const NodeIcon = node.icon;
            const containsActive =
              node.kind === "single"
                ? node.view === current
                : node.children.some((c) => c.key === current);
            const target: ViewKey = node.kind === "single" ? node.view : node.children[0].key;
            return (
              <Tooltip key={node.key}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => onNavigate(target)}
                    aria-label={node.label}
                    aria-current={containsActive ? "page" : undefined}
                    className={cn(
                      "flex items-center justify-center rounded-md size-10 mx-auto transition-colors",
                      containsActive
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-sidebar-foreground/85 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
                    )}
                  >
                    <NodeIcon className="size-5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left" className="bg-popover text-popover-foreground">
                  {node.label}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </nav>
      </TooltipProvider>
    );
  }

  return (
    <nav aria-label="منوی اصلی سیستم" className="flex flex-col gap-1 px-2 py-3 flex-1 overflow-y-auto">
      {nodes.map((node) => {
        const NodeIcon = node.icon;

        // Single direct button — navigates immediately, no accordion.
        if (node.kind === "single") {
          const active = current === node.view;
          return (
            <button
              key={node.key}
              type="button"
              onClick={() => onNavigate(node.view)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-sm transition-colors text-start",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground font-semibold"
                  : "text-sidebar-foreground/85 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
              )}
            >
              <NodeIcon className={cn("size-4.5 shrink-0", active ? "text-gold" : "opacity-75")} />
              <span className="truncate flex-1">{node.label}</span>
            </button>
          );
        }

        const open = openSection === node.key;
        const containsActive = node.children.some((c) => c.key === current);
        return (
          <div key={node.key}>
            <button
              type="button"
              onClick={() => toggleSection(node.key)}
              aria-expanded={open}
              aria-controls={`nav-section-${node.key}`}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-sm transition-colors text-start",
                containsActive && !open
                  ? "bg-sidebar-accent/70 text-sidebar-accent-foreground font-semibold"
                  : "text-sidebar-foreground/85 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                containsActive && open && "text-sidebar-accent-foreground font-semibold"
              )}
            >
              <NodeIcon
                className={cn("size-4.5 shrink-0", containsActive ? "text-gold" : "opacity-75")}
              />
              <span className="truncate flex-1">{node.label}</span>
              <ChevronDown
                className={cn(
                  "size-4 shrink-0 opacity-70 transition-transform duration-150",
                  open && "rotate-180"
                )}
                aria-hidden
              />
            </button>
            {/* Accordion body — smooth grid-rows animation */}
            <div
              id={`nav-section-${node.key}`}
              className="grid transition-[grid-template-rows] duration-150 ease-out"
              style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
              hidden={!open}
            >
              <div className="overflow-hidden">
                <div className="relative flex flex-col gap-0.5 py-1 ps-9 pe-2">
                  {/* RTL tree guide line */}
                  <span
                    aria-hidden
                    className="absolute top-1 bottom-1 start-6 w-px bg-sidebar-border"
                  />
                  {node.children.map((child) => {
                    const ChildIcon = child.icon;
                    const active = current === child.key;
                    return (
                      <button
                        key={child.key}
                        type="button"
                        onClick={() => onNavigate(child.key)}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "relative flex items-center gap-2 rounded-md px-2.5 py-2 text-[13px] transition-colors text-start",
                          active
                            ? "bg-sidebar-accent text-sidebar-accent-foreground font-semibold"
                            : "text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground"
                        )}
                      >
                        {active && (
                          <span
                            aria-hidden
                            className="absolute -start-0 top-1/2 -translate-y-1/2 h-4 w-1 rounded-full bg-gold"
                          />
                        )}
                        <ChildIcon
                          className={cn(
                            "size-4 shrink-0",
                            active ? "text-gold" : "opacity-70"
                          )}
                        />
                        <span className="truncate">{child.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </nav>
  );
}

function QuickActionsMenu() {
  const user = useAppStore((s) => s.user);
  const setView = useAppStore((s) => s.setView);
  const setCreateIntent = useAppStore((s) => s.setCreateIntent);
  const role = user?.role ?? "";
  const actions = React.useMemo(
    () => QUICK_ACTIONS.filter((a) => a.roles.includes(role)),
    [role]
  );
  if (!actions.length) return null;

  const run = (key: QuickAction["key"]) => {
    setView(QUICK_ACTION_TARGETS[key]);
    // The target view opens its EXISTING create dialog via this intent.
    setCreateIntent(key);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 h-9 px-2.5 sm:px-3 font-medium"
          aria-label="اقدامات سریع"
        >
          <Zap className="size-4 text-gold" />
          <span className="hidden sm:inline">اقدامات سریع</span>
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex items-center gap-1.5 text-xs">
          <Zap className="size-3.5 text-gold" />
          اقدامات سریع
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {actions.map((a) => {
          const Icon = a.icon;
          return (
            <DropdownMenuItem key={a.key} onClick={() => run(a.key)} className="py-2.5">
              <span className="size-7 rounded-md bg-primary/10 text-primary grid place-items-center shrink-0">
                <Icon className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium leading-4">{a.label}</span>
                <span className="block text-[11px] text-muted-foreground leading-4 mt-0.5">
                  {a.description}
                </span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ============================================================
// Notifications bell — counters are server-scoped to the user's port
// ============================================================

interface NotificationsPayload {
  quotaAlerts: number;
  todayImports: number;
  draftEntries: number;
}

function NotificationsMenu() {
  const setView = useAppStore((s) => s.setView);
  const { data } = useQuery<NotificationsPayload>({
    queryKey: ["notifications"],
    queryFn: () => apiFetch<NotificationsPayload>("/api/notifications"),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const total =
    (data?.quotaAlerts ?? 0) + (data?.draftEntries ?? 0);

  const rows: { label: string; value: number; onClick: () => void; icon: React.ReactNode; tone: string }[] = [
    {
      label: "سهمیه‌های نزدیک به حد",
      value: data?.quotaAlerts ?? 0,
      onClick: () => setView("limits-review"),
      icon: <Gauge className="size-4" />,
      tone: "bg-danger-soft text-danger",
    },
    {
      label: "مسوده‌های باز",
      value: data?.draftEntries ?? 0,
      onClick: () => setView("entries"),
      icon: <FilePlus2 className="size-4" />,
      tone: "bg-warning-soft text-warning",
    },
    {
      label: "واردات امروز",
      value: data?.todayImports ?? 0,
      onClick: () => setView("entries"),
      icon: <CheckCircle2 className="size-4" />,
      tone: "bg-success-soft text-success",
    },
  ];

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`اطلاعیه‌ها${total > 0 ? ` — ${toPersianDigits(total)} مورد` : ""}`}
          className="relative rounded-md border bg-card hover:bg-muted/60 p-2 transition-colors"
        >
          <Bell className="size-4.5 text-muted-foreground" />
          {total > 0 && (
            <span className="absolute -top-1.5 -end-1.5 min-w-4.5 h-4.5 rounded-full bg-danger text-white text-[10px] font-bold grid place-items-center px-1 tabular-nums">
              {toPersianDigits(total)}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        <div className="text-xs font-semibold px-2 py-1.5 text-muted-foreground">اطلاعیه‌ها</div>
        <div className="px-2 pb-1 text-[10px] text-muted-foreground">
          هشدارهای مشتق‌شده از معلومات زنده — با رفع مشکل خودبه‌خود پاک می‌شوند.
        </div>
        <div className="flex flex-col gap-1">
          {rows.map((r) => (
            <button
              key={r.label}
              type="button"
              onClick={r.onClick}
              className="flex items-center gap-2.5 rounded-md px-2 py-2 text-sm hover:bg-muted transition-colors text-start"
            >
              <span className={cn("size-7 rounded-md grid place-items-center shrink-0", r.tone)}>
                {r.icon}
              </span>
              <span className="flex-1 min-w-0">{r.label}</span>
              <span className="font-bold tabular-nums text-sm">{toPersianDigits(r.value)}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ============================================================
// Global search — importers & entries, debounced, scope-safe
// (the API enforces the caller's port scope server-side)
// ============================================================

interface SearchResult {
  importers: { id: number; name: string; importerCode: string; companyName: string | null; importerType: string }[];
  groups?: { id: number; code: string; name: string; representative: { id: number; name: string; importerCode: string } | null }[];
  entries: { id: number; entryNumber: string; status: string; importer: { name: string }; checkpoint: { name: string } }[];
}

function GlobalSearch() {
  const [q, setQ] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const boxRef = React.useRef<HTMLDivElement>(null);
  const setView = useAppStore((s) => s.setView);
  const setPendingSearch = useAppStore((s) => s.setPendingSearch);

  // 300ms debounce
  const [debounced, setDebounced] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const enabled = open && debounced.length >= 2;
  const { data, isFetching } = useQuery<SearchResult>({
    queryKey: ["global-search", debounced],
    queryFn: async () => {
      const [imp, ent, grp] = await Promise.all([
        apiFetch<{ importers: SearchResult["importers"] }>(
          `/api/importers?q=${encodeURIComponent(debounced)}`
        ),
        apiFetch<{ entries: SearchResult["entries"] }>(
          `/api/entries?q=${encodeURIComponent(debounced)}`
        ),
        apiFetch<{ groups: NonNullable<SearchResult["groups"]> }>(
          "/api/importer-groups"
        ).catch(() => ({ groups: [] as NonNullable<SearchResult["groups"]> })),
      ]);
      // Group codes/names/representatives are matched client-side (small list).
      const needle = debounced.toLowerCase();
      const groupHits = grp.groups.filter(
        (g) =>
          g.code.toLowerCase().includes(needle) ||
          g.name.toLowerCase().includes(needle) ||
          (g.representative?.name ?? "").toLowerCase().includes(needle)
      );
      return {
        importers: imp.importers.slice(0, 5),
        entries: ent.entries.slice(0, 5),
        groups: groupHits.slice(0, 3),
      };
    },
    enabled,
  });

  // Ctrl/Cmd+K focuses the search box
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        boxRef.current?.querySelector("input")?.focus();
        setOpen(true);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Clicking a result is an ACTION: navigate to the list (filtered) and
  // open the record — importer summary panel or entry detail dialog.
  // The focusId hand-off also works when the target view is already open.
  const goImporter = (id: number, name: string) => {
    setView("importers");
    setPendingSearch({ view: "importers", q: name, focusId: id });
    setOpen(false);
    setQ("");
  };
  const goEntry = (id: number, entryNumber: string) => {
    setView("entries");
    setPendingSearch({ view: "entries", q: entryNumber, focusId: id });
    setOpen(false);
    setQ("");
  };

  const hasResults =
    (data?.importers.length ?? 0) + (data?.entries.length ?? 0) + (data?.groups?.length ?? 0) > 0;

  const goGroup = (id: number, name: string) => {
    setView("importers");
    setPendingSearch({ view: "importers", q: name });
    setOpen(false);
    setQ("");
  };

  return (
    <div ref={boxRef} className="relative hidden sm:block">
      <Popover open={open && enabled} onOpenChange={(v) => setOpen(v)}>
        <PopoverTrigger asChild>
          <div className="relative">
            <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
            <Input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setOpen(true);
              }}
              onFocus={() => setOpen(true)}
              placeholder="جستجو (واردکننده، گروپ یا نمبر ثبت)…"
              aria-label="جستجوی عمومی"
              className="ps-8 pe-8 h-9 w-48 md:w-64 bg-muted/50"
            />
            {q && (
              <button
                type="button"
                onClick={() => {
                  setQ("");
                  setOpen(false);
                }}
                aria-label="پاک کردن جستجو"
                className="absolute end-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 p-1.5">
          {isFetching && (
            <div className="px-3 py-4 text-xs text-muted-foreground">در حال جستجو…</div>
          )}
          {!isFetching && !hasResults && (
            <div className="px-3 py-4 text-xs text-muted-foreground">
              نتیجه‌ای برای «{debounced}» پیدا نشد.
            </div>
          )}
          {!isFetching && (data?.importers.length ?? 0) > 0 && (
            <div className="mb-1">
              <div className="px-2 py-1 text-[11px] font-semibold text-muted-foreground">واردکنندگان — برای باز کردن پرونده کلیک کنید</div>
              {data!.importers.map((i) => (
                <button
                  key={i.id}
                  type="button"
                  onClick={() => goImporter(i.id, i.name)}
                  title="باز کردن معلومات و سوابق واردکننده"
                  className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted text-start group"
                >
                  <Truck className="size-3.5 text-muted-foreground shrink-0" />
                  <span className="truncate flex-1">
                    {i.name}
                    {i.companyName ? ` — ${i.companyName}` : ""}
                  </span>
                  <span className="text-[11px] text-muted-foreground shrink-0 font-mono" dir="ltr">{i.importerCode}</span>
                  <ChevronLeft className="size-3.5 shrink-0 text-muted-foreground/60 group-hover:text-primary transition-colors" aria-hidden />
                </button>
              ))}
            </div>
          )}
          {!isFetching && (data?.groups?.length ?? 0) > 0 && (
            <div className="mb-1">
              <div className="px-2 py-1 text-[11px] font-semibold text-muted-foreground">گروپ‌ها — برای باز کردن مدیریت واردکنندگان کلیک کنید</div>
              {data!.groups!.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => goGroup(g.id, g.name)}
                  title="باز کردن مدیریت واردکنندگان"
                  className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted text-start group"
                >
                  <Users className="size-3.5 text-muted-foreground shrink-0" />
                  <span className="truncate flex-1">{g.name}</span>
                  <span className="text-[11px] text-muted-foreground shrink-0 font-mono" dir="ltr">{g.code}</span>
                  <ChevronLeft className="size-3.5 shrink-0 text-muted-foreground/60 group-hover:text-primary transition-colors" aria-hidden />
                </button>
              ))}
            </div>
          )}
          {!isFetching && (data?.entries.length ?? 0) > 0 && (
            <div>
              <div className="px-2 py-1 text-[11px] font-semibold text-muted-foreground">ثبت‌های واردات — برای باز کردن جزئیات کلیک کنید</div>
              {data!.entries.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => goEntry(e.id, e.entryNumber)}
                  title="باز کردن جزئیات ثبت واردات"
                  className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted text-start group"
                >
                  <FileText className="size-3.5 text-muted-foreground shrink-0" />
                  <span className="truncate flex-1">
                    <span className="font-mono" dir="ltr">{e.entryNumber}</span>
                    {" — "}
                    {e.importer.name}
                  </span>
                  <span className="text-[11px] text-muted-foreground shrink-0">{e.checkpoint.name}</span>
                  <ChevronLeft className="size-3.5 shrink-0 text-muted-foreground/60 group-hover:text-primary transition-colors" aria-hidden />
                </button>
              ))}
            </div>
          )}
          <div className="px-2 py-1.5 text-[10px] text-muted-foreground border-t mt-1 flex items-center justify-between gap-2">
            <span>کلید میان‌بر: Ctrl + K</span>
            <span>کلیک روی نتیجه = باز کردن پرونده</span>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function SidebarBrand({
  collapsed = false,
  onToggle,
}: {
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  return (
    <div
      className={cn(
        "p-4 border-b border-sidebar-border flex items-center justify-between gap-2",
        collapsed && "px-2 justify-center"
      )}
    >
      {collapsed ? (
        <div className="shrink-0 rounded-lg bg-white ring-1 ring-white/20 shadow-sm overflow-hidden size-10 grid place-items-center">
          <BrandLogo size={34} showText={false} light />
        </div>
      ) : (
        <BrandLogo size={40} light />
      )}
      {onToggle && !collapsed && (
        <Button
          variant="ghost"
          size="icon"
          className="text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/60 hidden lg:inline-flex"
          onClick={onToggle}
          aria-label="بستن منوی کناری"
        >
          <ChevronsRight className="size-4" />
        </Button>
      )}
      {onToggle && collapsed && (
        <Button
          variant="ghost"
          size="icon"
          className="text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/60 hidden lg:inline-flex"
          onClick={onToggle}
          aria-label="باز کردن منوی کناری"
        >
          <ChevronsLeft className="size-4" />
        </Button>
      )}
    </div>
  );
}

function SidebarFooterInfo({ collapsed = false }: { collapsed?: boolean }) {
  const user = useAppStore((s) => s.user);
  if (!user) return null;
  if (collapsed) {
    return (
      <div className="border-t border-sidebar-border py-2 flex justify-center">
        <span
          className="size-8 rounded-full bg-sidebar-accent text-sidebar-accent-foreground grid place-items-center text-xs font-bold"
          title={user.name}
        >
          {user.name?.trim().charAt(0) ?? "؟"}
        </span>
      </div>
    );
  }
  return (
    <div className="p-3 border-t border-sidebar-border text-xs text-sidebar-foreground/70 space-y-1">
      <div className="flex items-center gap-2 px-1">
        <span className="size-2 rounded-full bg-success" />
        <span className="truncate font-medium text-sidebar-foreground/90">{user.name}</span>
      </div>
      <div className="px-1">{user.roleDari}</div>
      <div className="px-1">
        {user.checkpointName ? `بندر مسئولیت: ${user.checkpointName}` : "دسترسی به تمام بنادر"}
      </div>
    </div>
  );
}

// ============================================================
// App shell
// ============================================================

export function AppShell({ children }: { children: React.ReactNode }) {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const setUser = useAppStore((s) => s.setUser);
  const user = useAppStore((s) => s.user);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const queryClient = useQueryClient();
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [clock, setClock] = React.useState<string>("");

  React.useEffect(() => {
    const update = () => setClock(formatJalaliDateTime(new Date()));
    update();
    const t = setInterval(update, 30000);
    return () => clearInterval(t);
  }, []);

  const logout = useMutation({
    mutationFn: () => apiFetch<{ success: boolean }>("/api/auth/logout", { method: "POST" }),
    onSuccess: () => {
      setUser(null);
      queryClient.clear();
      // Full reset guarantees no stale server-state survives the session teardown
      window.location.href = "/";
    },
  });

  const navigate = (v: ViewKey) => {
    setView(v);
    setMobileOpen(false);
  };

  const activeTitle = ALL_NAV_CHILDREN.find((i) => i.key === view)?.label ?? "";
  const crumbs = breadcrumbItems(view);
  const currentJy = toJalali(new Date()).jy;

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <div className="flex flex-1 min-h-0">
        {/* Desktop sidebar */}
        <aside
          className={cn(
            "hidden lg:flex flex-col shrink-0 bg-sidebar border-e border-sidebar-border sticky top-0 h-screen transition-[width] duration-200",
            sidebarCollapsed ? "w-14" : "w-64"
          )}
        >
          <SidebarBrand collapsed={sidebarCollapsed} onToggle={toggleSidebar} />
          <SidebarNav current={view} onNavigate={navigate} collapsed={sidebarCollapsed} />
          <SidebarFooterInfo collapsed={sidebarCollapsed} />
        </aside>

        {/* Main column */}
        <div className="flex-1 flex flex-col min-w-0">
          <header className="sticky top-0 z-30 bg-card/95 backdrop-blur border-b no-print">
            <div className="flex items-center justify-between gap-3 px-4 sm:px-6 h-14">
              <div className="flex items-center gap-3 min-w-0">
                <div className="lg:hidden">
                  <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
                    <SheetTrigger asChild>
                      <Button variant="outline" size="icon" aria-label="باز کردن منو">
                        <Menu className="size-5" />
                      </Button>
                    </SheetTrigger>
                    <SheetContent side="right" className="bg-sidebar p-0 w-72 flex flex-col">
                      <SheetTitle className="sr-only">منوی اصلی</SheetTitle>
                      <SidebarBrand />
                      <SidebarNav current={view} onNavigate={navigate} />
                      <SidebarFooterInfo />
                    </SheetContent>
                  </Sheet>
                </div>
                <div className="min-w-0">
                  {/* Breadcrumb trail: Section / Page */}
                  {crumbs.length > 1 && (
                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground leading-4">
                      {crumbs.map((c, i) => (
                        <span key={`${c.label}-${i}`} className="flex items-center gap-1">
                          {i > 0 && <span aria-hidden className="opacity-50">/</span>}
                          {i === crumbs.length - 1 ? (
                            <span className="text-foreground/70">{c.label}</span>
                          ) : (
                            <span>{c.label}</span>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="font-semibold text-sm sm:text-base truncate leading-6">{activeTitle}</div>
                </div>
              </div>

              <div className="flex items-center gap-2 sm:gap-3">
                <GlobalSearch />
                <QuickActionsMenu />
                <NotificationsMenu />
                <div className="hidden md:block text-xs text-muted-foreground border rounded-md px-2.5 py-1.5 bg-muted/50">
                  {clock}
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="flex items-center gap-2 rounded-full border bg-muted/60 hover:bg-muted px-2.5 py-1.5 transition-colors"
                      aria-label="منوی کاربر"
                    >
                      <span className="size-7 rounded-full bg-primary text-primary-foreground grid place-items-center text-xs font-bold">
                        {user?.name?.trim().charAt(0) ?? "؟"}
                      </span>
                      <span className="hidden sm:block text-xs font-medium max-w-32 truncate">{user?.name}</span>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuLabel>
                      <div className="font-medium">{user?.name}</div>
                      <div className="text-xs text-muted-foreground font-normal">{user?.email}</div>
                      <div className="text-xs text-muted-foreground font-normal mt-0.5">
                        {user?.roleDari}
                        {user?.checkpointName ? ` — ${user.checkpointName}` : ""}
                      </div>
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => logout.mutate()}
                      disabled={logout.isPending}
                    >
                      <LogOut className="size-4" />
                      خروج از سیستم
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </header>

          <main className="flex-1 p-4 sm:p-6 min-w-0">{children}</main>

          <footer className="mt-auto border-t bg-card no-print">
            <div className="px-4 sm:px-6 py-3 flex flex-col sm:flex-row items-center justify-between gap-1 text-xs text-muted-foreground">
              <div>© {toPersianDigits(currentJy)} شرکت نفت و گاز افغانستان — {APP_NAME}</div>
              <div>تمامی حقوق محفوظ است — منطقه‌ی زمانی: آسیا/کابل (UTC+۴:۳۰)</div>
            </div>
          </footer>
        </div>
      </div>
    </div>
  );
}
