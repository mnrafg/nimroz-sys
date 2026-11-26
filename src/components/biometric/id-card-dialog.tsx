"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import QRCode from "qrcode";
import { IdCard, Loader2, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiFetch } from "@/lib/client-api";
import { ORG_NAME, APP_NAME } from "@/lib/constants";
import { formatJalali, toPersianDigits } from "@/lib/jalali";
import { cn } from "@/lib/utils";
import { BIOMETRIC_STATUS_LABELS, IMPORTER_TYPE_LABELS } from "@/lib/biometric/types";

// ============================================================
// Printable importer identification card (چاپ کارت شناسایی)
// + representative card variant (کارت نماینده گروپ)
//
// CR80 proportions (85.6 × 54 mm) rendered in mm units, RTL, official
// AOGC logo, QR code containing an OPAQUE, SIGNED, REVOCABLE verifier
// token — never Tazkira numbers, templates or other sensitive data.
// Printing uses the app-wide print-area mechanism (browser print → PDF).
// Fingerprint templates are NEVER printed or exposed.
// ============================================================

export interface IdCardImporter {
  id: number;
  /** Remaining fields are optional — when missing the dialog fetches
   *  them from the existing summary endpoint (used by the representative
   *  card where the caller only knows the importer id). */
  importerCode?: string;
  name?: string;
  fatherName?: string | null;
  idCardNumber?: string | null;
  companyName?: string | null;
  status?: string;
  biometricStatus?: string;
  biometricEnrolledAt?: string | null;
  hasPhoto?: boolean;
  importerType?: string;
  /** Border-worker membership lines (from the importer list row). */
  groupName?: string | null;
  subgroupName?: string | null;
  representativeName?: string | null;
}

export type IdCardVariant = "importer" | "representative";

interface IdCardDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  importer: IdCardImporter | null;
  /** "representative" prints the distinct کارت نماینده گروپ. */
  variant?: IdCardVariant;
  /** Group the printed representative card stands for (from the groups manager). */
  groupForCard?: { code: string; name: string } | null;
}

interface CardData extends IdCardImporter {
  importerCode: string;
  name: string;
  fatherName: string | null;
  idCardNumber: string | null;
  companyName: string | null;
  status: string;
  biometricStatus: string;
  hasPhoto: boolean;
}

export function IdCardDialog({ open, onOpenChange, importer, variant = "importer", groupForCard }: IdCardDialogProps) {
  const [qrDataUrl, setQrDataUrl] = React.useState<string | null>(null);
  const [cardNumber, setCardNumber] = React.useState<string>("");

  // When the caller only knows the importer id (representative card), the
  // missing personal fields come from the EXISTING summary endpoint.
  const fetched = useQuery({
    queryKey: ["id-card-importer", importer?.id],
    queryFn: () => apiFetch<{ importer: CardData & { group: { code: string; name: string } | null } }>(`/api/importers/${importer!.id}/summary`),
    enabled: open && !!importer && importer.name === undefined,
  });

  const cardImporter: CardData | null = React.useMemo(() => {
    if (!importer) return null;
    if (importer.name !== undefined) return importer as CardData;
    const f = fetched.data?.importer;
    if (!f) return null;
    return { ...f };
  }, [importer, fetched.data]);

  React.useEffect(() => {
    if (!open || !importer) return;
    let active = true;
    setQrDataUrl(null);
    apiFetch<{ cardNumber: string; token: string; verifyPath: string }>("/api/biometric/card-token", {
      method: "POST",
      body: JSON.stringify({ importerId: importer.id }),
    })
      .then((res) => {
        if (!active) return;
        setCardNumber(res.cardNumber);
        const url = `${window.location.origin}${res.verifyPath}?t=${encodeURIComponent(res.token)}`;
        // QR content = opaque, signed, revocable verifier URL only
        return QRCode.toDataURL(url, {
          width: 360,
          margin: 1,
          color: { dark: "#171717", light: "#FFFFFF" },
          errorCorrectionLevel: "M",
        }).then((d) => active && setQrDataUrl(d));
      })
      .catch(() => active && setQrDataUrl(null));
    return () => {
      active = false;
    };
  }, [open, importer]);

  const print = async () => {
    if (!importer) return;
    try {
      // Audit the print action (fire-and-forget; printing must not be blocked)
      await apiFetch("/api/biometric/card-print", {
        method: "POST",
        body: JSON.stringify({ importerId: importer.id }),
      }).catch(() => undefined);
    } finally {
      window.print();
    }
  };

  if (!importer) return null;
  const issued = formatJalali(new Date());
  const isRep = variant === "representative";

  // Group lines for border-worker cards and representative cards.
  const groupName = isRep
    ? groupForCard?.name ?? cardImporter?.groupName ?? null
    : cardImporter?.groupName ?? null;
  const subgroupName = isRep ? null : cardImporter?.subgroupName ?? null;
  const repName = isRep ? null : cardImporter?.representativeName ?? null;

  const biometricLabel =
    cardImporter?.biometricStatus === "ENROLLED"
      ? BIOMETRIC_STATUS_LABELS[cardImporter.biometricStatus] ?? cardImporter.biometricStatus
      : "ثبت نشده";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IdCard className="size-5 text-primary" />
            {isRep ? "چاپ کارت نماینده گروپ" : "چاپ کارت شناسایی واردکننده"}
          </DialogTitle>
          <DialogDescription>
            کارت در ابعاد معیاری چاپ می‌شود؛ کد QR حاوی توکن تأیید ابهام‌دار است و هیچ معلومات حساس در آن درج نمی‌شود.
          </DialogDescription>
        </DialogHeader>

        {/* On-screen preview */}
        <div className="flex justify-center py-2 overflow-auto">
          {cardImporter ? (
            <IdCardPreview
              importer={cardImporter}
              cardNumber={cardNumber}
              qrDataUrl={qrDataUrl}
              issued={issued}
              biometricLabel={biometricLabel}
              variant={variant}
              groupName={groupName}
              subgroupName={subgroupName}
              repName={repName}
              groupCode={groupForCard?.code ?? null}
            />
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-10">
              <Loader2 className="size-4 animate-spin" /> در حال بارگذاری معلومات کارت…
            </div>
          )}
        </div>

        <div className="text-[11px] text-muted-foreground leading-5 rounded-md border bg-muted/30 p-2.5">
          از دیالوگ چاپ مرورگر گزینه «Save as PDF» را برای خروجی با کیفیت بالا انتخاب کنید. کارت‌های
          ابطال‌شده (واردکننده غیرفعال) از طریق اسکن کد QR قابل راستی‌آزمایی هستند و پیام ابطال نشان داده می‌شود.
        </div>

        <DialogFooter className="flex-row justify-start gap-2">
          <Button onClick={print} disabled={!qrDataUrl || !cardImporter}>
            <Printer className="size-4" /> چاپ کارت
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            بستن
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The print-area card — visible in preview, and the ONLY thing printed. */
function IdCardPreview({
  importer,
  cardNumber,
  qrDataUrl,
  issued,
  biometricLabel,
  variant,
  groupName,
  subgroupName,
  repName,
  groupCode,
}: {
  importer: CardData;
  cardNumber: string;
  qrDataUrl: string | null;
  issued: string;
  biometricLabel: string;
  variant: IdCardVariant;
  groupName: string | null;
  subgroupName: string | null;
  repName: string | null;
  groupCode: string | null;
}) {
  const isRep = variant === "representative";
  const isWorker = importer.importerType === "BORDER_WORKER";
  return (
    <div className="print-area" aria-label={isRep ? "کارت نماینده گروپ" : "کارت شناسایی واردکننده"}>
      <style>{`
        @media print {
          @page { size: 86mm 56mm; margin: 0; }
          /* Keep ONLY the dialog that carries the card: everything else
             (app shell, other dialogs, toasts) is removed from layout so
             hidden-but-laid-out content cannot generate blank pages. */
          body > *:not([data-slot="dialog-content"]) { display: none !important; }
          [data-slot="dialog-content"]:not(:has(.print-area)) { display: none !important; }
          /* Neutralize the dialog's centering/animation box so the card
             positions against the physical page, not the on-screen dialog. */
          [data-slot="dialog-content"] {
            position: static !important;
            inset: auto !important;
            translate: none !important;
            transform: none !important;
            width: auto !important;
            max-width: none !important;
            max-height: none !important;
            overflow: visible !important;
            padding: 0 !important;
            margin: 0 !important;
            border: 0 !important;
            background: #fff !important;
            box-shadow: none !important;
            gap: 0 !important;
            display: block !important;
          }
          [data-slot="dialog-content"] > * { padding: 0 !important; margin: 0 !important; }
          [data-slot="dialog-content"] > *:not(:has(.print-area)) { display: none !important; }
          /* Override the app-wide .print-area padding: the card must keep
             its exact CR80 size on the 86×56mm page (no clipping, no
             shifting, one single page). */
          .print-area {
            position: static !important;
            inset: auto !important;
            width: auto !important;
            max-width: none !important;
            max-height: none !important;
            padding: 1mm 0 !important;
            background: #fff !important;
            box-shadow: none !important;
            display: flex !important;
            justify-content: center !important;
          }
          .card-shell {
            box-shadow: none !important;
            /* Force the teal header + dark footer bands to print with
               their real colors (browsers strip backgrounds by default). */
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
          .card-shell * {
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
          /* Deterministic typography: browsers must not apply their own
             minimum-font-size or zoom to the mm-based card. */
          .card-shell span, .card-shell div {
            text-rendering: geometricPrecision;
          }
        }
      `}</style>
      <div
        className="card-shell bg-white text-[#171717] rounded-xl overflow-hidden shadow-lg"
        style={{
          width: "85.6mm",
          height: "54mm",
          display: "flex",
          flexDirection: "column",
          WebkitPrintColorAdjust: "exact",
          printColorAdjust: "exact",
        } as React.CSSProperties}
        dir="rtl"
      >
        {/* Header band */}
        <div
          className="flex items-center justify-between gap-2 px-3 text-white shrink-0"
          style={{ background: "#005963", height: "13mm" }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <div
              className="bg-white rounded-md overflow-hidden shrink-0 grid place-items-center"
              style={{ width: "9.5mm", height: "9.5mm", padding: "0.5mm" }}
            >
              <img src="/aogc-logo.png" alt="لوگوی شرکت نفت و گاز افغانستان" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
            </div>
            <div className="min-w-0 leading-tight">
              <div className="truncate" style={{ fontSize: "7.6pt", fontWeight: 700, lineHeight: 1.25 }}>{ORG_NAME}</div>
              <div className="truncate" style={{ fontSize: "5.6pt", opacity: 0.85, lineHeight: 1.3 }}>
                {APP_NAME} — {isRep ? "کارت نماینده گروپ" : isWorker ? "کارت شناسایی کارگر مرزنشین" : "کارت شناسایی واردکننده"}
              </div>
            </div>
          </div>
          <div
            className="shrink-0 rounded-md bg-white/15 border border-white/25 px-1.5 py-0.5 whitespace-nowrap"
            style={{ fontSize: "6.2pt", fontWeight: 600, letterSpacing: 0 }}
            dir="ltr"
          >
            {cardNumber}
          </div>
        </div>

        {/* Body */}
        <div className="flex gap-2.5 px-3 min-h-0" style={{ flex: 1, paddingTop: "2mm", paddingBottom: "1.4mm" }}>
          {/* Photo — a broken/unreadable photo NEVER leaks giant alt text
              into the printed card (onerror → neutral placeholder). */}
          <div
            className="shrink-0 rounded-md border overflow-hidden bg-[#F4F6F7] grid place-items-center"
            style={{ width: "17mm", height: "21.5mm", fontSize: "5.6pt" }}
          >
            {importer.hasPhoto ? (
              <img
                src={`/api/importers/${importer.id}/photo`}
                alt=""
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
                onError={(e) => {
                  const el = e.currentTarget;
                  el.style.display = "none";
                  const parent = el.parentElement;
                  if (parent && !parent.querySelector(".card-photo-fallback")) {
                    const span = document.createElement("span");
                    span.className = "card-photo-fallback";
                    span.textContent = "بدون عکس";
                    span.style.fontSize = "5.6pt";
                    span.style.color = "#9CA3AF";
                    parent.appendChild(span);
                  }
                }}
              />
            ) : (
              <span style={{ fontSize: "5.6pt", color: "#9CA3AF" }}>بدون عکس</span>
            )}
          </div>

          {/* Info rows — ONE shared grid so every value starts at the same
              column and long text never pushes the card out of its bounds. */}
          <div
            className="min-w-0 flex-1 grid items-baseline content-start"
            style={{
              gridTemplateColumns: "auto 1fr",
              columnGap: "1.2mm",
              rowGap: "0.5mm",
              fontSize: "6.4pt",
              lineHeight: 1.35,
            }}
          >
            {isRep ? (
              <>
                <CardRow label="نام نماینده" value={importer.name} strong />
                <CardRow label="نمبر واردکننده" value={importer.importerCode} mono />
                <CardRow label="نام پدر" value={importer.fatherName ?? "—"} />
                <CardRow
                  label="گروپ مسئولیت"
                  value={groupName ? `${groupName}${groupCode ? ` — ${groupCode}` : ""}` : "—"}
                  strong
                />
                <CardRow label="وضعیت ثبت" value={importer.status === "ACTIVE" ? "فعال" : "غیرفعال"} />
                <CardRow label="بایومتریک" value={biometricLabel} />
              </>
            ) : isWorker ? (
              <>
                <CardRow label="نام واردکننده" value={importer.name} strong />
                <CardRow label="نمبر واردکننده" value={importer.importerCode} mono />
                <CardRow label="نام پدر" value={importer.fatherName ?? "—"} />
                <CardRow
                  label="گروپ"
                  value={groupName ? `${groupName}${subgroupName ? ` — ${subgroupName}` : ""}` : "—"}
                />
                <CardRow label="نماینده مسئول" value={repName ?? "—"} />
                <CardRow label="بایومتریک" value={biometricLabel} />
              </>
            ) : (
              <>
                <CardRow label="نام واردکننده" value={importer.name} strong />
                <CardRow label="نام پدر" value={importer.fatherName ?? "—"} />
                <CardRow label="نمبر واردکننده" value={importer.importerCode} mono />
                {importer.companyName ? <CardRow label="شرکت" value={importer.companyName} /> : null}
                <CardRow label="نوع" value={IMPORTER_TYPE_LABELS[importer.importerType ?? "COMMERCIAL"] ?? "واردکننده تجارتی"} />
                <CardRow label="وضعیت ثبت" value={importer.status === "ACTIVE" ? "فعال" : "غیرفعال"} />
                <CardRow label="بایومتریک" value={biometricLabel} />
              </>
            )}
          </div>

          {/* QR */}
          <div className="shrink-0 flex flex-col items-center justify-start" style={{ width: "14.5mm" }}>
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt="کد QR تأیید کارت"
                style={{ width: "14mm", height: "14mm" }}
              />
            ) : (
              <div className="border border-dashed rounded" style={{ width: "14mm", height: "14mm" }} />
            )}
            <div style={{ fontSize: "5pt", color: "#7C7C7C", textAlign: "center", marginTop: "0.6mm", lineHeight: 1.2 }}>
              اسکن برای تأیید
            </div>
          </div>
        </div>

        {/* Footer strip */}
        <div
          className="flex items-center justify-between gap-2 px-3 text-white shrink-0"
          style={{ background: "#1F2937", height: "6mm", fontSize: "5.2pt" }}
        >
          <span className="shrink-0 whitespace-nowrap">تاریخ صدور: {issued}</span>
          <span className="truncate text-end" style={{ opacity: 0.9 }}>
            {isRep
              ? "نماینده مسئول گروپ — این کارت انتقال‌ناپذیر است"
              : "این کارت انتقال‌ناپذیر است — در صورت یافتن، به شرکت نفت و گاز افغانستان بازدهید"}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * One label + value pair rendered INSIDE the shared card grid
 * (gridTemplateColumns: "auto 1fr") so all values align on a single
 * column and never wrap out of the fixed CR80 card bounds.
 */
function CardRow({ label, value, strong, mono }: { label: string; value: string; strong?: boolean; mono?: boolean }) {
  return (
    <>
      <span
        className="whitespace-nowrap"
        style={{ fontSize: "5.8pt", color: "#5E6E71", fontWeight: 600 }}
      >
        {label}:
      </span>
      <span
        className={cn(
          strong ? "font-bold" : "font-medium",
          "min-w-0 block whitespace-nowrap overflow-hidden text-ellipsis"
        )}
        style={
          mono
            ? { fontFamily: "ui-monospace, monospace", fontSize: "6.4pt", direction: "ltr", textAlign: "right" }
            : { fontSize: "6.4pt" }
        }
        title={value}
      >
        {value}
      </span>
    </>
  );
}
