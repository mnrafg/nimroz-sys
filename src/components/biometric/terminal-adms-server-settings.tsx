"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, RefreshCw, Server, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiFetch } from "@/lib/client-api";

interface AdmsServerResponse {
  serverUrl: string | null;
  apiUrl: string | null;
  hasApiToken: boolean;
  tokenTransportAllowed: boolean;
  settings: { readEnabled: boolean };
  configError?: "DB_UNAVAILABLE" | "STORED_VALUE_CORRUPT" | "DEPLOYMENT_CONFIG_UNAVAILABLE" | null;
  check?: { reachable: boolean; status?: number; server?: string | null; message: string };
}

/**
 * The ADMS service is installed and configured by deployment operators.
 * This application only monitors its connection; changing listener/API
 * addresses or credentials from the browser risks breaking live imports.
 */
export function TerminalAdmsServerSettings() {
  const settings = useQuery({
    queryKey: ["terminal-adms-settings"],
    queryFn: () => apiFetch<AdmsServerResponse>("/api/biometric/terminal/adms-server"),
  });
  const [checking, setChecking] = React.useState(false);
  const [checkResult, setCheckResult] = React.useState<AdmsServerResponse["check"] | null>(null);
  const [checkError, setCheckError] = React.useState<string | null>(null);

  async function checkConnection() {
    setChecking(true);
    setCheckResult(null);
    setCheckError(null);
    try {
      const result = await apiFetch<AdmsServerResponse>("/api/biometric/terminal/adms-server?check=1");
      setCheckResult(result.check ?? null);
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : "بررسی اتصال ناموفق بود.");
    } finally {
      setChecking(false);
    }
  }

  const data = settings.data;
  return (
    <Card className="py-0">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Server className="size-4 text-primary" aria-hidden />
          وضعیت سرور ADMS
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 p-4 pt-1">
        <p className="text-xs leading-6 text-muted-foreground">
          اتصال سرور ADMS فقط یک‌بار توسط مسئول سرور ثبت می‌شود و برای تمام کاربران و استقرارهای بعدی محفوظ می‌ماند؛
          حتی اگر پایگاه دادهٔ جدید ساخته شود. در این صفحه نیازی به واردکردن آدرس، پورت یا توکن نیست.
        </p>
        {settings.isLoading ? (
          <p className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" /> در حال دریافت وضعیت…</p>
        ) : settings.isError || !data ? (
          <div role="alert" className="rounded-md border border-danger/30 p-3 text-sm text-danger">
            {settings.error instanceof Error ? settings.error.message : "خواندن وضعیت ADMS ناموفق بود."}
          </div>
        ) : (
          <>
            {data.configError && (
              <div role="alert" className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft p-3 text-xs text-warning">
                <ShieldAlert className="size-4 shrink-0" />
                {data.configError === "DB_UNAVAILABLE"
                  ? "خواندن تنظیمات ذخیره‌شده ناموفق بود؛ مسئول سرور باید اتصال پایگاه داده را بررسی کند."
                  : data.configError === "DEPLOYMENT_CONFIG_UNAVAILABLE"
                    ? "اتصال ذخیره‌شده قابل خواندن نیست؛ مسئول سرور باید نسخهٔ پشتیبان تنظیمات اتصال را بازیابی کند."
                    : "تنظیمات ذخیره‌شده خراب است؛ مسئول سرور باید آن را اصلاح کند."}
              </div>
            )}
            <dl className="grid gap-3 text-xs sm:grid-cols-2">
              <Info label="آدرس دریافت رویداد دستگاه‌ها" value={data.serverUrl ?? "تنظیم نشده"} />
              <Info label="آدرس API برنامه" value={data.apiUrl ?? "تنظیم نشده"} />
              <Info label="خواندن اسکن‌های جدید" value={data.settings.readEnabled ? "فعال" : "غیرفعال"} />
              <Info label="احراز هویت API" value={data.hasApiToken ? "توکن موجود" : "توکن موجود نیست"} />
            </dl>
            {data.hasApiToken && !data.tokenTransportAllowed && (
              <p role="alert" className="text-xs text-danger">
                انتقال توکن روی HTTP عمومی مجاز نیست؛ مسئول سرور باید HTTPS یا تونل امن تنظیم کند.
              </p>
            )}
            <p className="text-xs leading-6 text-muted-foreground">
              پورت دستگاه‌شنونده (معمولاً 8081) با API خصوصی (معمولاً 8082 یا HTTPS روی 8443) متفاوت است.
              پاسخ 404 معمولاً نشان می‌دهد آدرس API به پورت دستگاه‌شنونده اشاره دارد.
              API باید از بک‌اند برنامه قابل دسترس باشد؛ سلامت API به‌تنهایی آنلاین بودن دستگاه را تأیید نمی‌کند.
            </p>
          </>
        )}
        {checkResult && (
          <div role="status" className="rounded-md border p-3 text-sm">
            <div className={checkResult.reachable ? "text-success" : "text-danger"}>{checkResult.message}</div>
            {checkResult.status && <div dir="ltr">HTTP {checkResult.status}</div>}
          </div>
        )}
        {checkError && <p role="alert" className="text-sm text-danger">{checkError}</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={settings.isFetching} onClick={() => void settings.refetch()}>
            <RefreshCw className={settings.isFetching ? "size-4 animate-spin" : "size-4"} /> تازه‌سازی
          </Button>
          <Button type="button" disabled={checking || !data || !!data.configError} onClick={() => void checkConnection()}>
            {checking && <Loader2 className="size-4 animate-spin" />} بررسی اتصال API
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-3">
      <dt className="mb-1 text-muted-foreground">{label}</dt>
      <dd dir={value.includes("://") ? "ltr" : undefined} className="break-all font-medium">{value}</dd>
    </div>
  );
}
