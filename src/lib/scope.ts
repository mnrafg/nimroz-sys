import { SessionUser } from "@/lib/auth";

/**
 * Central port-scoping helper (server-side).
 *
 * Every operational API must derive its data scope from THIS module — never
 * from client-supplied checkpoint IDs.
 *
 *   ADMIN      → all ports (nationwide)
 *   non-admin with checkpointId → only their assigned port
 *   non-admin WITHOUT checkpointId → NO operational data (must contact admin)
 */
export type PortScope =
  | { kind: "all" }
  | { kind: "port"; checkpointId: number }
  | { kind: "none" };

export function portScopeFor(user: Pick<SessionUser, "role" | "checkpointId">): PortScope {
  if (user.role === "ADMIN") return { kind: "all" };
  if (user.checkpointId) return { kind: "port", checkpointId: user.checkpointId };
  return { kind: "none" };
}

/** Dari message shown when a non-admin account has no assigned port. */
export const NO_PORT_MESSAGE =
  "شما به هیچ بندر مسئولیت تخصیص داده نشده‌اید؛ برای تعیین بندر مسئولیت لطفاً با مدیر سیستم تماس بگیرید.";

/** Dari message for cross-port record access attempts. */
export const CROSS_PORT_MESSAGE =
  "شما فقط به معلومات بندر مسئولیت خود دسترسی دارید.";

/**
 * Effective Prisma `where` fragment for checkpoint filtering.
 * The requested checkpointId is honored ONLY for admins; port-restricted
 * users are always forced onto their own port, and port-less non-admins
 * must be rejected by the caller beforehand (`requirePortScope`).
 */
export function scopedCheckpointFilter(
  user: Pick<SessionUser, "role" | "checkpointId">,
  requestedCheckpointId?: number | null
): { checkpointId: number } | Record<string, never> {
  const scope = portScopeFor(user);
  if (scope.kind === "all") {
    return requestedCheckpointId ? { checkpointId: requestedCheckpointId } : {};
  }
  if (scope.kind === "port") return { checkpointId: scope.checkpointId };
  return {};
}

/**
 * Record-level guard. Returns a Dari error message when `checkpointId` is
 * outside the user's scope (or the user has no port), otherwise null.
 */
export function assertPortAccess(
  user: Pick<SessionUser, "role" | "checkpointId">,
  checkpointId: number | null | undefined
): string | null {
  if (checkpointId === null || checkpointId === undefined) return null;
  const scope = portScopeFor(user);
  if (scope.kind === "all") return null;
  if (scope.kind === "port" && scope.checkpointId === checkpointId) return null;
  if (scope.kind === "none") return NO_PORT_MESSAGE;
  return CROSS_PORT_MESSAGE;
}

/**
 * Guard used by list/report endpoints that cannot degrade gracefully.
 * Returns the scope when access is allowed, or a Dari error when the
 * non-admin account has no assigned port.
 */
export function requirePortScope(
  user: Pick<SessionUser, "role" | "checkpointId">
): { ok: true; scope: PortScope } | { ok: false; message: string } {
  const scope = portScopeFor(user);
  if (scope.kind === "none") return { ok: false, message: NO_PORT_MESSAGE };
  return { ok: true, scope };
}

// ============================================================
// Central importer registry — visibility & management rules
//
// The registry stays CENTRAL (one identity per importer; duplicate
// checks and biometric identification work nationwide), but which
// identities a port account can BROWSE / MANAGE is scoped:
//   ADMIN                  → all importers
//   port user              → importers registered at their port,
//                            centrally registered (null), or active
//                            at their port (entries/limits there)
//   non-admin without port → NO registry access at all
// Operational data (history/quotas/approvals) remains port-scoped
// everywhere regardless of identity visibility.
// ============================================================

export function importerVisibilityWhere(
  user: Pick<SessionUser, "role" | "checkpointId">
): Record<string, unknown> | null {
  const scope = portScopeFor(user);
  if (scope.kind === "all") return {};
  if (scope.kind !== "port") return null; // no registry access
  return {
    OR: [
      { registeredCheckpointId: null },
      { registeredCheckpointId: scope.checkpointId },
      { entries: { some: { checkpointId: scope.checkpointId } } },
      { limits: { some: { checkpointId: scope.checkpointId } } },
    ],
  };
}

/**
 * Include fragment used to load the ownership evidence needed by
 * `canManageImporter` / `canViewImporter` (distinct ports of activity).
 * The mutable `distinct` tuple satisfies Prisma's field-enum type.
 */
export const importerScopeEvidence = {
  entries: { select: { checkpointId: true }, distinct: ["checkpointId" as const] },
  limits: { select: { checkpointId: true }, distinct: ["checkpointId" as const] },
};

export type ImporterScopeEvidence = {
  registeredCheckpointId: number | null;
  entries: { checkpointId: number }[];
  limits: { checkpointId: number }[];
};

/**
 * May this user SEE the identity of this importer in the central registry?
 * Mirrors the `importerVisibilityWhere` list-scoping rule for a single
 * record — used to close the by-ID enumeration gap (V4/V5).
 */
export function canViewImporter(
  user: Pick<SessionUser, "role" | "checkpointId">,
  importer: ImporterScopeEvidence
): boolean {
  const scope = portScopeFor(user);
  if (scope.kind === "all") return true;
  if (scope.kind !== "port") return false;
  if (
    importer.registeredCheckpointId === null ||
    importer.registeredCheckpointId === scope.checkpointId
  ) {
    return true;
  }
  return (
    importer.entries.some((e) => e.checkpointId === scope.checkpointId) ||
    importer.limits.some((l) => l.checkpointId === scope.checkpointId)
  );
}

/**
 * May this user EDIT/manage this importer (master-identity fields)?
 * Operational data is scoped separately — this guards identity changes
 * (bio data, group membership, status …) against cross-port tampering.
 */
export function canManageImporter(
  user: Pick<SessionUser, "role" | "checkpointId">,
  importer: ImporterScopeEvidence
): boolean {
  const scope = portScopeFor(user);
  if (scope.kind === "all") return true;
  if (scope.kind !== "port") return false;
  if (
    importer.registeredCheckpointId === null ||
    importer.registeredCheckpointId === scope.checkpointId
  ) {
    return true;
  }
  return (
    importer.entries.some((e) => e.checkpointId === scope.checkpointId) ||
    importer.limits.some((l) => l.checkpointId === scope.checkpointId)
  );
}
