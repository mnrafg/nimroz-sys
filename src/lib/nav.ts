import {
  BarChart3,
  Database,
  FilePlus2,
  Fingerprint,
  Gauge,
  LayoutDashboard,
  Package,
  Ruler,
  Settings,
  Ship,
  SlidersHorizontal,
  Truck,
  UserCog,
} from "lucide-react";
import type { ViewKey } from "@/store/app-store";

// ============================================================
// Navigation model — single source of truth for the sidebar,
// top-bar breadcrumbs and active-page titles.
//
// IA per enterprise requirements (no approval workflow — registration is
// final on submit):
//   Dashboard | Importers & Groups | Quota Management (setup /
//   monitoring) | Import Operations | Reports | Master Data | Administration
// ============================================================

export interface NavChild {
  key: ViewKey;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  roles: string[];
}

export interface NavNode {
  key: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  roles: string[];
  /** Single direct page (no accordion). */
  view?: ViewKey;
  children?: NavChild[];
}

const ALL_ROLES = ["ADMIN", "OFFICER"];

export const NAV_ITEMS: NavNode[] = [
  {
    key: "dashboard",
    label: "داشبورد",
    icon: LayoutDashboard,
    roles: ALL_ROLES,
    view: "dashboard",
  },
  {
    key: "importers",
    label: "واردکنندگان و گروپ‌ها",
    icon: Truck,
    roles: ALL_ROLES,
    view: "importers",
  },
  {
    key: "quota",
    label: "سهمیه بندی",
    icon: Gauge,
    roles: ALL_ROLES,
    children: [
      { key: "limits", label: "تعیین محدودیت واردات", icon: Gauge, roles: ALL_ROLES },
      { key: "limits-review", label: "مانیتورینگ سهمیه‌ها", icon: SlidersHorizontal, roles: ALL_ROLES },
    ],
  },
  {
    key: "entries",
    label: "ثبت واردات",
    icon: FilePlus2,
    roles: ALL_ROLES,
    view: "entries",
  },
  {
    key: "reports",
    label: "گزارشات",
    icon: BarChart3,
    roles: ALL_ROLES,
    view: "reports",
  },
  {
    key: "master",
    label: "مدیریت معلومات اساسی",
    icon: Database,
    roles: ALL_ROLES,
    children: [
      { key: "items", label: "اجناس", icon: Package, roles: ALL_ROLES },
      { key: "uoms", label: "واحدات", icon: Ruler, roles: ALL_ROLES },
      { key: "checkpoints", label: "بنادر", icon: Ship, roles: ALL_ROLES },
    ],
  },
  {
    key: "system",
    label: "مدیریت سیستم",
    icon: Settings,
    roles: ["ADMIN"],
    children: [
      { key: "users", label: "کاربران", icon: UserCog, roles: ["ADMIN"] },
      { key: "terminal-devices", label: "تنظیمات دستگاه‌های بایومتریک", icon: Fingerprint, roles: ["ADMIN"] },
      { key: "settings", label: "تنظیمات سیستم", icon: Settings, roles: ["ADMIN"] },
    ],
  },
];

export const ALL_NAV_CHILDREN: NavChild[] = NAV_ITEMS.flatMap((n) =>
  n.view ? [{ key: n.view, label: n.label, icon: n.icon, roles: n.roles }] : (n.children ?? [])
);

export function sectionForView(view: ViewKey): string | null {
  const section = NAV_ITEMS.find(
    (n) => !n.view && (n.children ?? []).some((c) => c.key === view)
  );
  return section?.key ?? null;
}

/** Breadcrumb trail for a view: [Section] / [Page] (or just [Page]). */
export function breadcrumbItems(view: ViewKey): { label: string }[] {
  const sectionKey = sectionForView(view);
  if (!sectionKey) {
    const item = NAV_ITEMS.find((n) => n.view === view);
    return item ? [{ label: item.label }] : [];
  }
  const section = NAV_ITEMS.find((n) => n.key === sectionKey)!;
  const child = (section.children ?? []).find((c) => c.key === view);
  return [
    { label: section.label },
    { label: child?.label ?? "" },
  ].filter((i) => i.label);
}
