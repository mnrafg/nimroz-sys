/**
 * One-time migration: remove the approval workflow.
 *
 * - PENDING entries (submitted, awaiting supervisor approval) become APPROVED
 *   — the registration is now final on submit.
 * - PENDING exception lines become APPROVED (their reason is preserved).
 *
 * Run: bun run prisma/migrate-no-approval.ts
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const pendingEntries = await db.importEntry.findMany({
    where: { status: "PENDING" },
    select: { id: true, createdAt: true },
  });

  for (const e of pendingEntries) {
    await db.importEntry.update({
      where: { id: e.id },
      data: {
        status: "APPROVED",
        approvedAt: e.createdAt,
        // approvedBy stays null → the UI shows the entry as finalized by the system migration.
      },
    });
    await db.approvalAction.createMany({
      data: [
        {
          importEntryId: e.id,
          actionType: "APPROVE",
          actionBy: (await db.importEntry.findUnique({ where: { id: e.id }, select: { createdBy: true } }))?.createdBy ?? 1,
          remarks: "ثبت نهایی (مهاجرت سیستم — بدون جریان تأیید)",
        },
      ],
    });
  }

  const pendingExceptions = await db.importEntryItem.updateMany({
    where: { exceptionStatus: "PENDING" },
    data: { exceptionStatus: "APPROVED" },
  });

  // Audit note
  const admin = await db.user.findFirst({ where: { role: { name: "ADMIN" } } });
  await db.auditLog.create({
    data: {
      userId: admin?.id ?? null,
      action: "MIGRATE",
      recordType: "SYSTEM",
      recordId: null,
      newValues: JSON.stringify({
        change: "approval-workflow-removed",
        entriesFinalized: pendingEntries.length,
        exceptionsApproved: pendingExceptions.count,
        at: new Date().toISOString(),
      }),
    },
  });

  console.log(
    `Migration done: ${pendingEntries.length} PENDING entries → APPROVED, ${pendingExceptions.count} PENDING exceptions → APPROVED.`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
