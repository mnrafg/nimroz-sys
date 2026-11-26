import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export type Tx = Prisma.TransactionClient;

/**
 * Durable, concurrency-safe sequence allocation backed by the
 * SequenceCounter table.
 *
 * Guarantees:
 *  - each call inside a transaction returns a DISTINCT value;
 *  - the counter is seeded (once) ABOVE the highest number already issued
 *    in the matching records — values of deleted/canceled records are
 *    never reused;
 *  - SQLite serializes write transactions, so counter increments are
 *    atomic; the unique constraint on the target column is the final
 *    safety net (callers should retry allocation on P2002).
 */
export async function nextSequence(
  tx: Tx,
  counterId: string,
  opts: {
    /** Seed scan: highest already-issued numeric value (0 when none). */
    seedFrom?: number;
    /** Minimum value when no seed scan applies. */
    min?: number;
    step?: number;
  } = {}
): Promise<number> {
  const step = opts.step && opts.step > 0 ? opts.step : 1;
  const floor = Math.max(opts.min ?? 1, opts.seedFrom ?? 0);

  const existing = await tx.sequenceCounter.findUnique({ where: { id: counterId } });
  if (!existing) {
    // Seed safely above everything already issued.
    const seeded = floor + step;
    try {
      await tx.sequenceCounter.create({ data: { id: counterId, value: seeded } });
      return seeded;
    } catch {
      // Lost a create race (unique conflict on counter id) — fall through
      // to the increment path.
    }
  }
  const updated = await tx.sequenceCounter.update({
    where: { id: counterId },
    data: { value: { increment: step } },
  });
  if (updated.value < floor) {
    // Counter behind the seeded floor (should not happen — floors only rise).
    const bumped = await tx.sequenceCounter.update({
      where: { id: counterId },
      data: { value: floor + step },
    });
    return bumped.value;
  }
  return updated.value;
}

/**
 * Allocate a unique, never-reused string number of the shape
 * `${prefix}${String(n).padStart(pad, "0")}`.
 *
 * `exists` lets the allocator verify against live records (guards the rare
 * case where a seeded counter would still collide with a hand-created
 * record). On collision the counter keeps advancing.
 */
export async function allocateNumber(
  tx: Tx,
  counterId: string,
  opts: {
    prefix: string;
    pad?: number;
    seedFrom?: number;
    min?: number;
    exists?: (candidate: string) => Promise<boolean>;
  }
): Promise<string> {
  const pad = opts.pad ?? 3;
  for (let attempt = 0; attempt < 10; attempt++) {
    const n = await nextSequence(tx, counterId, {
      seedFrom: opts.seedFrom,
      min: opts.min,
    });
    const candidate = `${opts.prefix}${String(n).padStart(pad, "0")}`;
    if (!opts.exists || !(await opts.exists(candidate))) return candidate;
  }
  throw new Error(`Failed to allocate a unique number for ${counterId}`);
}

/** Highest numeric suffix found among values of the shape prefix+digits. */
export function maxNumericSuffix(values: string[], prefix: string): number {
  let max = 0;
  for (const v of values) {
    if (!v || !v.startsWith(prefix)) continue;
    const rest = v.slice(prefix.length);
    const n = Number(rest.split(/[^0-9]/)[0]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}
