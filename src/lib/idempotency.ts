import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export type Tx = Prisma.TransactionClient;

/**
 * Idempotent-create protection.
 *
 * A client supplies an opaque key when it STARTS a create flow; the first
 * successful request records the created record id under that key. Retries
 * of the same request (double-clicks, flaky networks, duplicated form
 * submissions) replay the SAME record instead of creating a duplicate.
 *
 * Keys are scoped per entity type so the same random key can never alias
 * across different resources.
 */
export async function findIdempotentRecord(
  tx: Tx,
  key: string | null | undefined,
  entityType: string
): Promise<number | null> {
  if (!key || typeof key !== "string") return null;
  const k = key.trim();
  if (k.length < 8 || k.length > 200) return null;
  const rec = await tx.idempotencyRecord.findUnique({ where: { key: `${entityType}:${k}` } });
  return rec?.entityId ?? null;
}

export async function recordIdempotency(
  tx: Tx,
  key: string | null | undefined,
  entityType: string,
  entityId: number
): Promise<void> {
  if (!key || typeof key !== "string") return;
  const k = key.trim();
  if (k.length < 8 || k.length > 200) return;
  try {
    await tx.idempotencyRecord.create({
      data: { key: `${entityType}:${k}`, entityType, entityId },
    });
  } catch {
    // Lost a race — another request with the same key already recorded an
    // entity. That entity IS the canonical result for this key.
  }
}

/** Generate a fresh client-side idempotency key. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `k-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}
