"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { BrandLogo } from "@/components/brand";
import { AppShell } from "@/components/app-shell";
import { LoginView } from "@/components/login-view";
import { DashboardView } from "@/components/views/dashboard-view";
import { EntriesView } from "@/components/views/entries-view";
import { ImportersView } from "@/components/views/importers-view";
import { ItemsView } from "@/components/views/items-view";
import { UomsView } from "@/components/views/uoms-view";
import { CheckpointsView } from "@/components/views/checkpoints-view";
import { LimitsView } from "@/components/views/limits-view";
import { ReportsView } from "@/components/views/reports-view";
import { UsersView } from "@/components/views/users-view";
import { TerminalDevicesView } from "@/components/views/terminal-devices-view";
import { SettingsView } from "@/components/views/settings-view";
import { apiFetch } from "@/lib/client-api";
import { useAppStore, type AppUser, type ViewKey, resolveView } from "@/store/app-store";

export default function Home() {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const me = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return await apiFetch<{ user: AppUser }>("/api/auth/me");
      } catch {
        return { user: null };
      }
    },
    staleTime: Infinity,
    retry: false,
  });

  const setUser = useAppStore((s) => s.setUser);
  const view = useAppStore((s) => s.view);

  React.useEffect(() => {
    if (me.data?.user) setUser(me.data.user);
  }, [me.data?.user, setUser]);

  if (!mounted) {
    return (
      <div className="min-h-screen grid place-items-center bg-background">
        <div className="animate-pulse">
          <BrandLogo size={64} />
        </div>
      </div>
    );
  }

  if (me.isLoading) {
    return (
      <div className="min-h-screen grid place-items-center bg-background">
        <div className="animate-pulse">
          <BrandLogo size={64} />
        </div>
      </div>
    );
  }

  if (!me.data?.user) {
    return <LoginView />;
  }

  // Resolve preset nav keys (approved/rejected entries, exceptions, report presets)
  // to the concrete view plus its initial state.
  const { view: baseView, preset } = resolveView(view as ViewKey);

  const views: Record<string, React.ReactNode> = {
    dashboard: <DashboardView />,
    entries: <EntriesView />,
    importers: <ImportersView />,
    items: <ItemsView />,
    uoms: <UomsView />,
    checkpoints: <CheckpointsView />,
    limits: (
      <LimitsView key={`limits-${preset.limitsReview ? "review" : "manage"}`} reviewMode={preset.limitsReview} />
    ),
    reports: (
      <ReportsView key={`reports-${preset.reportType ?? "general"}`} initialType={preset.reportType} />
    ),
    users: <UsersView />,
    "terminal-devices": <TerminalDevicesView />,
    settings: <SettingsView />,
  };

  return <AppShell>{views[baseView] ?? views.dashboard}</AppShell>;
}
