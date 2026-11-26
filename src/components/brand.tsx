"use client";

import Image from "next/image";
import { APP_NAME, ORG_NAME, ORG_SHORT } from "@/lib/constants";
import { cn } from "@/lib/utils";

export function BrandLogo({
  size = 40,
  showText = true,
  light = false,
  className,
}: {
  size?: number;
  showText?: boolean;
  light?: boolean;
  className?: string;
}) {
  const pad = Math.max(2, Math.round(size * 0.1));
  return (
    <div className={cn("flex items-center gap-2.5 min-w-0", className)}>
      {/* Official AOGC flame logo — shown exactly as supplied on a white plate,
          never cropped or distorted */}
      <div
        className="shrink-0 rounded-xl bg-white ring-1 ring-border shadow-sm overflow-hidden"
        style={{ width: size, height: size, padding: pad }}
      >
        <Image
          src="/aogc-logo.png"
          alt={`لوگوی رسمی ${ORG_SHORT} — ${ORG_NAME}`}
          width={size * 2}
          height={size * 2}
          className="w-full h-full object-contain"
          priority
        />
      </div>
      {showText && (
        <div className="min-w-0 leading-tight">
          <div
            className={cn(
              "font-bold truncate",
              light ? "text-white" : "text-primary"
            )}
            style={{ fontSize: Math.max(size * 0.34, 12) }}
          >
            {ORG_NAME}
          </div>
          <div
            className={cn(
              "truncate",
              light ? "text-white/70" : "text-muted-foreground"
            )}
            style={{ fontSize: Math.max(size * 0.22, 10) }}
          >
            {APP_NAME}
          </div>
        </div>
      )}
    </div>
  );
}

export function BrandTitle({ light = false, className }: { light?: boolean; className?: string }) {
  return (
    <div className={cn("leading-tight text-center", className)}>
      <div className={cn("font-bold", light ? "text-white" : "text-primary")}>{ORG_NAME}</div>
      <div className={cn("text-xs mt-0.5", light ? "text-white/70" : "text-muted-foreground")}>
        {APP_NAME}
      </div>
    </div>
  );
}
