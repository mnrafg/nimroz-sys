"use client";

import { create } from "zustand";

export type ViewKey =
  | "dashboard"
  // عملیات واردات
  | "entries"
  // مدیریت معلومات اساسی
  | "importers"
  | "items"
  | "uoms"
  | "checkpoints"
  // سهمیه بندی
  | "limits"
  | "limits-review"
  // گزارشات
  | "reports"
  | "reports-imports"
  | "reports-limits"
  | "reports-ports"
  // مدیریت سیستم
  | "users"
  | "terminal-devices"
  | "settings";

export type BaseView =
  | "dashboard"
  | "entries"
  | "importers"
  | "items"
  | "uoms"
  | "checkpoints"
  | "limits"
  | "reports"
  | "users"
  | "terminal-devices"
  | "settings";

/** Resolve a nav preset key to the concrete view + initial state. */
export function resolveView(view: ViewKey): {
  view: BaseView;
  preset: {
    reportType?: string;
    limitsReview?: boolean;
  };
} {
  switch (view) {
    case "limits-review":
      return { view: "limits", preset: { limitsReview: true } };
    case "reports-imports":
      return { view: "reports", preset: { reportType: "daily" } };
    case "reports-limits":
      return { view: "reports", preset: { reportType: "remaining_quota" } };
    case "reports-ports":
      return { view: "reports", preset: { reportType: "checkpoint" } };
    default:
      return { view: view as BaseView, preset: {} };
  }
}

export interface AppUser {
  id: number;
  name: string;
  email: string;
  role: string;
  roleDari: string;
  checkpointId: number | null;
  checkpointName: string | null;
}

export type QuickActionIntent = "importer" | "entry" | "limit" | null;

/** One-shot cross-view hand-off that CARRIES a selected record's context
 *  (e.g. "New import" from an importer profile pre-selects that importer;
 *  "Add member" from a group detail pre-selects group + subgroup). */
export interface ContextIntent {
  importerId?: number;
  groupId?: number;
  subgroupId?: number;
  checkpointId?: number;
  itemId?: number;
}

/** One-shot search hand-off from the global search to a list view. */
export interface PendingSearch {
  view: BaseView;
  q: string;
  /** Record to OPEN on arrival — importer summary panel / entry detail
   *  dialog. Global search results are clickable actions, not just text. */
  focusId?: number;
}

interface AppState {
  user: AppUser | null;
  view: ViewKey;
  sidebarCollapsed: boolean;
  /** Pending "open create dialog" request from the quick-actions bar. */
  createIntent: QuickActionIntent;
  /** Pending global-search hand-off consumed by list views on mount. */
  pendingSearch: PendingSearch | null;
  /** Pending create-with-context requests (keyed by target view). */
  entryIntent: ContextIntent | null;
  importerIntent: ContextIntent | null;
  limitIntent: ContextIntent | null;
  setUser: (u: AppUser | null) => void;
  setView: (v: ViewKey) => void;
  toggleSidebar: () => void;
  setCreateIntent: (intent: QuickActionIntent) => void;
  consumeCreateIntent: (intent: Exclude<QuickActionIntent, null>) => boolean;
  setPendingSearch: (s: PendingSearch) => void;
  consumePendingSearch: (view: BaseView) => PendingSearch | null;
  setEntryIntent: (i: ContextIntent | null) => void;
  consumeEntryIntent: () => ContextIntent | null;
  setImporterIntent: (i: ContextIntent | null) => void;
  consumeImporterIntent: () => ContextIntent | null;
  setLimitIntent: (i: ContextIntent | null) => void;
  consumeLimitIntent: () => ContextIntent | null;
}

export const useAppStore = create<AppState>((set, get) => ({
  user: null,
  view: "dashboard",
  sidebarCollapsed: false,
  createIntent: null,
  pendingSearch: null,
  entryIntent: null,
  importerIntent: null,
  limitIntent: null,
  setUser: (user) => set({ user }),
  setView: (view) => set({ view }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setCreateIntent: (createIntent) => set({ createIntent }),
  /** One-shot consumption: true if the pending intent matches. */
  consumeCreateIntent: (intent) => {
    if (get().createIntent === intent) {
      set({ createIntent: null });
      return true;
    }
    return false;
  },
  setPendingSearch: (pendingSearch) => set({ pendingSearch }),
  /** Returns the pending search (and clears it) when it targets `view`. */
  consumePendingSearch: (view) => {
    const s = get().pendingSearch;
    if (s && s.view === view) {
      set({ pendingSearch: null });
      return s;
    }
    return null;
  },
  setEntryIntent: (entryIntent) => set({ entryIntent }),
  consumeEntryIntent: () => {
    const i = get().entryIntent;
    if (i) set({ entryIntent: null });
    return i;
  },
  setImporterIntent: (importerIntent) => set({ importerIntent }),
  consumeImporterIntent: () => {
    const i = get().importerIntent;
    if (i) set({ importerIntent: null });
    return i;
  },
  setLimitIntent: (limitIntent) => set({ limitIntent }),
  consumeLimitIntent: () => {
    const i = get().limitIntent;
    if (i) set({ limitIntent: null });
    return i;
  },
}));
