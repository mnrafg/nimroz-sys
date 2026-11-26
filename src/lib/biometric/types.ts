// ============================================================
// Shared biometric contract types (client + server safe — no node
// deps). Retained for the TERMINAL biometric stack (LAN / ADMS) and
// the importer ID-card verification token. The old USB-scanner /
// localhost-bridge contract types were removed with that stack.
// ============================================================

/** Consistent biometric status vocabulary across importer list,
 *  enrollment, device settings and imports. */
export const BIOMETRIC_STATUS_LABELS: Record<string, string> = {
  NOT_ENROLLED: "ثبت نشده",
  ENROLLED: "ثبت‌شده",
  REVOKED: "ابطال‌شده",
};

export interface ImporterSummaryResponse {
  importer: {
    id: number;
    importerCode: string;
    name: string;
    fatherName: string | null;
    tazkiraNumber: string | null;
    province: string | null;
    companyName: string | null;
    licenseNumber: string | null;
    phone: string | null;
    address: string | null;
    status: string;
    idCardNumber: string | null;
    biometricStatus: string;
    biometricEnrolledAt: string | null;
    hasPhoto: boolean;
    importerType: string;
    membershipStatus: string;
    group: {
      id: number;
      code: string;
      name: string;
      status: string;
      representative: { id: number; name: string; importerCode: string } | null;
    } | null;
    subgroup: { id: number; code: string; name: string } | null;
  };
  quotas: Array<{
    limitId: number;
    source: "INDIVIDUAL" | "GROUP";
    groupName: string | null;
    checkpoint: { id: number; name: string };
    periodType: string;
    allowedQuantity: number;
    uomSymbol: string;
    restriction: string | null;
    windowLabel: string | null;
    allowedBaseQuantity: number | null;
    approvedBaseQuantity: number | null;
    remainingBaseQuantity: number | null;
    overQuota: boolean;
    conversionError: boolean;
    /** GROUP quota = PER-MEMBER allowance — member-level numbers. */
    perMember: boolean;
    memberCount: number | null;
    totalAllowedQuantity: number | null;
    memberConsumed: number | null;
    memberRemaining: number | null;
  }>;
  today: {
    approvedEntries: number;
    approvedBaseQuantity: number | null;
    lastImportAt: string | null;
    lastCheckpointName: string | null;
  };
  entries: Array<{
    id: number;
    entryNumber: string;
    importDatetime: string;
    status: string;
    checkpoint: { name: string };
    items: Array<{ itemName: string; quantity: number; uomSymbol: string }>;
  }>;
  entriesTotal: number;
}

/** Importer type labels (border-import regulation). */
export const IMPORTER_TYPE_LABELS: Record<string, string> = {
  BORDER_WORKER: "کارگر مرزنشین",
  COMMERCIAL: "واردکننده تجارتی",
};
