"use client";

/**
 * Typed fetch wrapper for the app's JSON APIs with Dari error messages.
 *
 * Error taxonomy (spec §2 — failed requests must NEVER look like empty
 * results):
 *  • network/service failure  → NET-… reference, "عدم دسترسی به سرور برنامه"
 *  • 401 unauthorized         → session-expired message (login flow handles it)
 *  • 403 forbidden            → server's Dari message
 *  • 4xx                      → server's Dari message
 *  • 5xx                      → server's sanitized message + correlation ref
 *
 * The reference (NET-…/ERR-…) is a short correlation code only — it never
 * contains stack traces, SQL or host details.
 */
export class ApiRequestError extends Error {
  readonly ref: string | null;
  readonly status: number | null;
  readonly kind: "NETWORK" | "UNAUTHORIZED" | "FORBIDDEN" | "SERVER" | "CLIENT";

  constructor(message: string, opts?: { ref?: string | null; status?: number | null; kind?: ApiRequestError["kind"] }) {
    super(message);
    this.name = "ApiRequestError";
    this.ref = opts?.ref ?? null;
    this.status = opts?.status ?? null;
    this.kind = opts?.kind ?? "CLIENT";
  }
}

function shortRef(prefix: string): string {
  const t = Date.now().toString(36).toUpperCase().slice(-6);
  const r = Math.random().toString(36).toUpperCase().slice(2, 6);
  return `${prefix}-${t}-${r}`;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: "same-origin",
      ...init,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    // fetch() itself threw — the application server is unreachable
    // (server down, network drop, DNS). This is a SERVICE failure, not
    // an empty result.
    throw new ApiRequestError(
      "عدم دسترسی به سرور برنامه؛ اتصال شبکه یا سرور را بررسی کنید و دوباره تلاش نمایید.",
      { ref: shortRef("NET"), kind: "NETWORK" }
    );
  }

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    // non-JSON (e.g. file download handled separately)
  }

  if (!res.ok) {
    const serverMsg =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: string }).error)
        : null;
    const serverRef =
      payload && typeof payload === "object" && "ref" in payload
        ? String((payload as { ref: string }).ref)
        : null;

    if (res.status === 401) {
      throw new ApiRequestError(
        serverMsg ?? "نشست شما منقضی شده است؛ لطفاً دوباره وارد سیستم شوید.",
        { ref: serverRef, status: res.status, kind: "UNAUTHORIZED" }
      );
    }
    if (res.status === 403) {
      throw new ApiRequestError(serverMsg ?? "شما اجازه انجام این عملیه را ندارید.", {
        ref: serverRef,
        status: res.status,
        kind: "FORBIDDEN",
      });
    }
    if (res.status >= 500) {
      const msg = serverMsg ?? "خطا در ارتباط با سرور؛ لطفاً دوباره تلاش کنید.";
      throw new ApiRequestError(
        serverRef ? `${msg} (کد پیگیری: ${serverRef})` : msg,
        { ref: serverRef, status: res.status, kind: "SERVER" }
      );
    }
    throw new ApiRequestError(serverMsg ?? "خطا در ارتباط با سرور؛ لطفاً دوباره تلاش کنید.", {
      ref: serverRef,
      status: res.status,
      kind: "CLIENT",
    });
  }
  return payload as T;
}

/** Download a file (e.g. Excel export) preserving auth cookies. */
export async function downloadFile(path: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "same-origin" });
  } catch {
    throw new ApiRequestError("عدم دسترسی به سرور برنامه؛ اتصال شبکه را بررسی کنید.", {
      ref: shortRef("NET"),
      kind: "NETWORK",
    });
  }
  if (!res.ok) {
    let msg = "خطا در دریافت فایل";
    try {
      const payload = await res.json();
      if (payload?.error) msg = payload.error;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const match = disposition.match(/filename="?([^";]+)"?/);
  const fileName = match?.[1] ?? "download.xlsx";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
