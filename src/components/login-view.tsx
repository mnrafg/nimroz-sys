"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Eye, EyeOff, Loader2, LogIn, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BrandLogo, BrandTitle } from "@/components/brand";
import { apiFetch } from "@/lib/client-api";
import { useAppStore, type AppUser } from "@/store/app-store";
import { APP_NAME } from "@/lib/constants";

export function LoginView() {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [showPw, setShowPw] = React.useState(false);
  const queryClient = useQueryClient();
  const setUser = useAppStore((s) => s.setUser);

  const login = useMutation({
    mutationFn: (vars: { email: string; password: string }) =>
      apiFetch<{ user: AppUser }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify(vars),
      }),
    onSuccess: (data) => {
      setUser(data.user);
      queryClient.setQueryData(["me"], data);
      queryClient.invalidateQueries();
      toast.success(`خوش آمدید، ${data.user.name}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-bl from-primary via-primary to-[#013d44] relative overflow-hidden">
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            "radial-gradient(circle at 20% 30%, #C9A227 0, transparent 40%), radial-gradient(circle at 80% 70%, #C9A227 0, transparent 45%)",
        }}
      />
      <div className="w-full max-w-4xl grid lg:grid-cols-2 rounded-2xl overflow-hidden shadow-2xl ring-1 ring-white/15 relative bg-card">
        {/* Brand side */}
        <div className="hidden lg:flex flex-col items-center justify-center gap-6 bg-primary/95 p-10 text-primary-foreground">
          <div className="rounded-2xl bg-white p-3 shadow-lg ring-1 ring-black/5">
            <img src="/aogc-logo.png" alt="لوگوی رسمی AOGC" className="size-28 object-contain" />
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold">شرکت نفت و گاز افغانستان</div>
            <div className="mt-1 text-base font-medium text-primary-foreground/90">{APP_NAME}</div>
            <div className="mt-3 text-sm text-primary-foreground/80 leading-6">
              مدیریت واردکنندگان، حد مجاز واردات، ثبت و تأیید واردات مرزی
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-primary-foreground/70">
            <ShieldCheck className="size-4" />
            دسترسی امن چندکاربره — تقویم هجری شمسی — منطقه‌ی زمانی آسیا/کابل
          </div>
        </div>

        {/* Form side */}
        <div className="p-6 sm:p-10 flex flex-col justify-center gap-6">
          <div className="flex flex-col items-center gap-3 lg:hidden">
            <img src="/aogc-logo.png" alt="لوگوی رسمی AOGC" className="size-20 object-contain rounded-2xl bg-white ring-1 ring-gold/60 p-1.5" />
            <BrandTitle />
          </div>

          <div className="hidden lg:block">
            <BrandLogo size={44} />
          </div>

          <div>
            <h1 className="text-xl font-bold">ورود به سیستم</h1>
            <p className="text-sm text-muted-foreground mt-1">
              لطفاً اطلاعات حساب کاربری خود را وارد نمایید.
            </p>
          </div>

          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              const cleanEmail = email.trim().slice(0, 254);
              const cleanPassword = password.slice(0, 128);
              if (!cleanEmail || !cleanPassword) {
                toast.error("لطفاً ایمیل و پاسورد را وارد نمایید.");
                return;
              }
              login.mutate({ email: cleanEmail, password: cleanPassword });
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="email">آدرس ایمیل</Label>
              <Input
                id="email"
                type="email"
                dir="ltr"
                className="text-left"
                placeholder="user@aogc.gov.af"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                inputMode="email"
                maxLength={254}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">پاسورد</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPw ? "text" : "password"}
                  dir="ltr"
                  className="text-left pl-10"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={128}
                  required
                />
                <button
                  type="button"
                  aria-label={showPw ? "پنهان کردن پاسورد" : "نمایش پاسورد"}
                  className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1"
                  onClick={() => setShowPw((s) => !s)}
                >
                  {showPw ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>

            <Button type="submit" className="w-full h-10" disabled={login.isPending}>
              {login.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  در حال ورود...
                </>
              ) : (
                <>
                  <LogIn className="size-4" />
                  ورود به سیستم
                </>
              )}
            </Button>
          </form>

          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
            <ShieldCheck className="size-4 shrink-0 mt-0.5 text-amber-600" />
            <span>
              دسترسی به این سیستم فقط برای کاربران مجاز است. تمام فعالیت‌ها شامل ورودها و تلاش‌های ناموفق ثبت و پایش می‌شود.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
