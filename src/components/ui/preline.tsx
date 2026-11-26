"use client";

import * as React from "react";
import { CheckCircle2, Info, TriangleAlert, X, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Preline-pattern callout/alert (علائم هشدار).
 * Follows the Preline UI alert design: soft tinted surface, leading icon,
 * title + description body and an optional close button. Behavior stays
 * fully React-controlled (no vanilla-JS DOM mutation).
 */

export type PlAlertTone = "info" | "success" | "warning" | "danger";

const TONES: Record<
  PlAlertTone,
  { wrap: string; icon: string; iconEl: React.ReactNode }
> = {
  info: {
    wrap: "border-border bg-info-soft text-foreground",
    icon: "bg-primary/10 text-primary",
    iconEl: <Info className="size-4.5" aria-hidden />,
  },
  success: {
    wrap: "border-success/25 bg-success-soft text-foreground",
    icon: "bg-success/10 text-success",
    iconEl: <CheckCircle2 className="size-4.5" aria-hidden />,
  },
  warning: {
    wrap: "border-warning/25 bg-warning-soft text-foreground",
    icon: "bg-warning/10 text-warning",
    iconEl: <TriangleAlert className="size-4.5" aria-hidden />,
  },
  danger: {
    wrap: "border-danger/25 bg-danger-soft text-foreground",
    icon: "bg-danger/10 text-danger",
    iconEl: <XCircle className="size-4.5" aria-hidden />,
  },
};

export function PlAlert({
  tone = "info",
  title,
  children,
  onClose,
  className,
  role,
}: {
  tone?: PlAlertTone;
  title: string;
  children?: React.ReactNode;
  onClose?: () => void;
  className?: string;
  role?: string;
}) {
  // Defensive fallback — an unknown/legacy tone (e.g. "default") must never
  // crash the form; it renders with the neutral info styling instead.
  const t = TONES[tone] ?? TONES.info;
  return (
    <div
      role={role ?? "alert"}
      className={cn(
        "flex items-start gap-2.5 rounded-xl border p-3.5",
        t.wrap,
        className
      )}
    >
      <span
        className={cn(
          "mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg",
          t.icon
        )}
        aria-hidden
      >
        {t.iconEl}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="text-sm font-semibold leading-5">{title}</div>
        {children && (
          <div className="text-xs leading-5 text-muted-foreground [&_ul]:list-disc [&_ul]:ps-5 [&_ul]:space-y-0.5">
            {children}
          </div>
        )}
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="بستن پیام"
          className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" aria-hidden />
        </button>
      )}
    </div>
  );
}
